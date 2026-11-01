import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createAigentError } from '../core/aigent-error.js';

export interface FileLockOptions {
  /** How long to wait for a lock held by a live owner before failing with `store_failed`. */
  lockTimeoutMs: number;
  /**
   * A lock whose owner has not refreshed it for this long is presumed left by a crashed (or hung) process and taken
   * over. A holder refreshes its lock every quarter of this, so a slow write never loses it.
   */
  staleLockMs: number;
  clock(): number;
  sleep(delayMs: number): Promise<void>;
}

/** What a lock (or break) file says about its owner. */
interface LockOwner {
  pid: number;
  /** Host of the owner: its pid is checked for liveness only on the same host. */
  host?: string;
  token: string;
  /** When the owner last refreshed the lock, by the injected clock (by the real clock for an unreadable file). */
  at: number;
  /** A file without a valid owner (created, not yet written, or hand-made): aged by its real mtime. */
  isUnreadable?: boolean;
}

export interface FileLock {
  /** Releases the lock if it is still ours; never throws. */
  release(): Promise<void>;
  /** Whether this acquirer removed a crashed owner's lock on the way: whatever that owner left half-done may still lie around. */
  tookOver: boolean;
}

interface LockContext {
  lockPath: string;
  options: FileLockOptions;
}

const EXISTS_CODE = 'EEXIST';
const MISSING_CODE = 'ENOENT';
const NO_SUCH_PROCESS_CODE = 'ESRCH';
const PENDING_DELETE_CODES = new Set(['EPERM', 'EACCES']);
const MIN_POLL_MS = 2;
const MAX_POLL_MS = 15;
/** The holder refreshes its lock this many times per `staleLockMs`. */
const HEARTBEATS_PER_STALE_PERIOD = 4;
const BREAK_HASH_LENGTH = 16;
/** Break files of break files: each level needs another crash inside a window of milliseconds. */
const MAX_BREAK_DEPTH = 3;
const HOST = hostname();

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

function pollDelay(): number {
  return MIN_POLL_MS + Math.random() * (MAX_POLL_MS - MIN_POLL_MS);
}

function newOwner(options: FileLockOptions): LockOwner {
  return { pid: process.pid, host: HOST, token: randomUUID(), at: options.clock() };
}

/** Reads the owner; a file that exists but holds no valid owner ages by its mtime. */
async function readOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<LockOwner>;
    if (typeof parsed.token === 'string' && typeof parsed.at === 'number') {
      return { pid: typeof parsed.pid === 'number' ? parsed.pid : 0, token: parsed.token, at: parsed.at, ...(typeof parsed.host === 'string' ? { host: parsed.host } : {}) };
    }
  } catch {
    // Missing, or not written yet: told apart below.
  }
  try {
    const { mtimeMs } = await stat(path);
    return { pid: 0, token: `unreadable-${mtimeMs}`, at: mtimeMs, isUnreadable: true };
  } catch {
    return undefined;
  }
}

function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return errorCode(error) === NO_SUCH_PROCESS_CODE;
  }
}

/** Stale: its process on this host has exited, or it was not refreshed for `staleLockMs` (each age by its own clock). */
function isStale(params: { owner: LockOwner; options: FileLockOptions }): boolean {
  const { owner, options: { staleLockMs, clock } } = params;
  if (owner.host === HOST && owner.pid > 0 && isProcessGone(owner.pid)) return true;
  const ageMs = owner.isUnreadable === true ? Date.now() - owner.at : clock() - owner.at;
  return ageMs > staleLockMs;
}

async function writeOwner(params: { handle: FileHandle; owner: LockOwner }): Promise<void> {
  const { handle, owner } = params;
  // Same length every time (`at` keeps its digit count), so overwriting in place never leaves stale bytes behind.
  await handle.write(JSON.stringify(owner), 0, 'utf8');
}

/** Creates `path` exclusively and writes the owner into it; undefined when it exists. The handle stays open for heartbeats. */
async function tryCreate(params: { path: string; owner: LockOwner }): Promise<FileHandle | undefined> {
  const { path, owner } = params;
  let handle: FileHandle;
  try {
    handle = await open(path, 'wx');
  } catch (error) {
    const code = errorCode(error);
    if (code === EXISTS_CODE) return undefined;
    // Windows reports a released file that another process still has open (delete pending) as EPERM or EACCES.
    if (process.platform === 'win32' && code != null && PENDING_DELETE_CODES.has(code)) return undefined;
    throw error;
  }
  try {
    await writeOwner({ handle, owner });
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return handle;
}

function breakPathOf(params: { lockPath: string; token: string }): string {
  const { lockPath, token } = params;
  return `${lockPath}.break-${createHash('sha256').update(token).digest('hex').slice(0, BREAK_HASH_LENGTH)}`;
}

/** Unlinks `path` if it still holds `token` and `when` agrees; only safe as the holder of that token's break file. */
async function removeIfStill(params: { path: string; token: string; when(owner: LockOwner): boolean }): Promise<boolean> {
  const { path, token, when } = params;
  const current = await readOwner(path);
  if (current?.token !== token || !when(current)) return false;
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== MISSING_CODE) throw error;
  }
  return true;
}

/**
 * Runs `action` as the one holder of `token`'s break file, created exclusively. Removing a file that holds `token`
 * (a takeover of a stale lock, or its owner's release) happens only there, so whoever reads `token` there knows it
 * stays until they remove it: no one can remove a lock that replaced it. Undefined when another contender holds the
 * break file; one left by a crashed contender is cleared (through a break file of its own) for the next try.
 */
async function asBreaker<R>(params: { context: LockContext; token: string; depth: number; action(): Promise<R> }): Promise<R | undefined> {
  const { context, token, depth, action } = params;
  const { lockPath, options } = context;
  const breakPath = breakPathOf({ lockPath, token });
  const owner = newOwner(options);
  const handle = await tryCreate({ path: breakPath, owner });
  if (handle == null) {
    const holder = await readOwner(breakPath);
    if (holder != null && depth < MAX_BREAK_DEPTH && isStale({ owner: holder, options })) {
      await asBreaker({
        context, token: holder.token, depth: depth + 1,
        action: () => removeIfStill({ path: breakPath, token: holder.token, when: stale => isStale({ owner: stale, options }) }),
      });
    }
    return undefined;
  }
  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await removeIfStill({ path: breakPath, token: owner.token, when: () => true }).catch(() => false);
  }
}

/** Keeps the lock's `at` fresh while it is held, so no contender ever judges a live holder stale. */
function startHeartbeat(params: { handle: FileHandle; owner: LockOwner; options: FileLockOptions }): () => Promise<void> {
  const { handle, owner, options: { staleLockMs, clock } } = params;
  let beat: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (beat != null) return;
    owner.at = clock();
    beat = writeOwner({ handle, owner }).catch(() => undefined).finally(() => { beat = undefined; });
  }, Math.max(1, Math.floor(staleLockMs / HEARTBEATS_PER_STALE_PERIOD)));
  timer.unref();
  return async () => {
    clearInterval(timer);
    await beat;
  };
}

/** Takes the exclusive lock at `lockPath`, waiting for a live owner and recovering from a crashed one. */
export async function acquireFileLock(lockPath: string, options: FileLockOptions): Promise<FileLock> {
  const { lockTimeoutMs, clock, sleep } = options;
  const context: LockContext = { lockPath, options };
  const owner = newOwner(options);
  const deadline = clock() + lockTimeoutMs;
  let tookOver = false;
  let handle: FileHandle | undefined;
  for (;;) {
    owner.at = clock();
    handle = await tryCreate({ path: lockPath, owner });
    if (handle != null) break;
    const current = await readOwner(lockPath);
    if (current != null && isStale({ owner: current, options })) {
      const { token } = current;
      const removed = await asBreaker({ context, token, depth: 0, action: () => removeIfStill({ path: lockPath, token, when: stale => isStale({ owner: stale, options }) }) });
      if (removed === true) tookOver = true;
      continue;
    }
    if (clock() >= deadline) {
      throw createAigentError({
        code: 'store_failed',
        message: `Could not lock '${lockPath}' within ${lockTimeoutMs} ms because another writer holds it; retry later or raise lockTimeoutMs`,
        details: { lockPath, lockTimeoutMs, heldBy: current },
      });
    }
    await sleep(pollDelay());
  }
  const held = handle;
  const stopHeartbeat = startHeartbeat({ handle: held, owner, options });

  async function release(): Promise<void> {
    await stopHeartbeat();
    await held.close().catch(() => undefined);
    const releaseDeadline = clock() + lockTimeoutMs;
    try {
      for (;;) {
        const done = await asBreaker({ context, token: owner.token, depth: 0, action: async () => { await removeIfStill({ path: lockPath, token: owner.token, when: () => true }); return true; } });
        // Busy: a contender is checking whether this lock is stale (it is not); that takes moments.
        if (done === true || clock() >= releaseDeadline) return;
        await sleep(pollDelay());
      }
    } catch {
      // Release never throws: a lock left behind is taken over once its process has exited.
    }
  }
  return { release, tookOver };
}
