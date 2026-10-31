import { randomUUID } from 'node:crypto';
import { link, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createAigentError } from '../core/aigent-error.js';

export interface FileLockOptions {
  /** How long to wait for a lock held by a live owner before failing with `store_failed`. */
  lockTimeoutMs: number;
  /** A lock older than this is presumed left by a crashed process and taken over. */
  staleLockMs: number;
  clock(): number;
  sleep(delayMs: number): Promise<void>;
}

/** What a lock file says about its owner. */
interface LockOwner {
  pid: number;
  token: string;
  at: number;
}

export interface FileLock {
  /** Releases the lock if it is still ours; never throws. */
  release(): Promise<void>;
}

const EXISTS_CODE = 'EEXIST';
const MISSING_CODE = 'ENOENT';
const PENDING_DELETE_CODES = new Set(['EPERM', 'EACCES']);
const MIN_POLL_MS = 2;
const MAX_POLL_MS = 15;

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

/** Reads the owner; a file that exists but holds no valid owner (created, then its process died) ages by its mtime. */
async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<LockOwner>;
    if (typeof parsed.token === 'string' && typeof parsed.at === 'number') {
      return { pid: typeof parsed.pid === 'number' ? parsed.pid : 0, token: parsed.token, at: parsed.at };
    }
  } catch {
    // Missing, or half-written: told apart below.
  }
  try {
    const { mtimeMs } = await stat(lockPath);
    return { pid: 0, token: `unreadable-${mtimeMs}`, at: mtimeMs };
  } catch {
    return undefined;
  }
}

async function tryCreate(lockPath: string, owner: LockOwner): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    const code = errorCode(error);
    if (code === EXISTS_CODE) return false;
    // Windows reports a released lock that another process still has open (delete pending) as EPERM or EACCES.
    if (process.platform === 'win32' && code != null && PENDING_DELETE_CODES.has(code)) return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(owner));
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Takes a stale lock over by renaming it away: only one contender's rename succeeds. If what was renamed is not the
 * lock that was judged stale (a live owner re-created it in between), it is put back untouched.
 */
async function takeOverStale(lockPath: string, staleToken: string): Promise<void> {
  const parkedPath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, parkedPath);
  } catch (error) {
    if (errorCode(error) === MISSING_CODE) return;
    throw error;
  }
  const parked = await readOwner(parkedPath);
  if (parked != null && parked.token !== staleToken) {
    try {
      await link(parkedPath, lockPath);
    } catch {
      // Someone else has already re-created the lock; the live owner's release is token-checked, so nothing is lost.
    }
  }
  await unlink(parkedPath).catch(() => undefined);
}

/** Takes the exclusive lock at `lockPath`, waiting for a live owner and recovering from a crashed one. */
export async function acquireFileLock(lockPath: string, options: FileLockOptions): Promise<FileLock> {
  const { lockTimeoutMs, staleLockMs, clock, sleep } = options;
  const owner: LockOwner = { pid: process.pid, token: randomUUID(), at: clock() };
  const deadline = clock() + lockTimeoutMs;
  for (;;) {
    owner.at = clock();
    if (await tryCreate(lockPath, owner)) break;
    const current = await readOwner(lockPath);
    if (current != null && clock() - current.at > staleLockMs) {
      await takeOverStale(lockPath, current.token);
      continue;
    }
    if (clock() >= deadline) {
      throw createAigentError({
        code: 'store_failed',
        message: `Could not lock '${lockPath}' within ${lockTimeoutMs} ms because another writer holds it; retry later or raise lockTimeoutMs`,
        details: { lockPath, lockTimeoutMs, heldBy: current },
      });
    }
    await sleep(MIN_POLL_MS + Math.random() * (MAX_POLL_MS - MIN_POLL_MS));
  }
  async function release(): Promise<void> {
    const current = await readOwner(lockPath);
    if (current?.token !== owner.token) return;
    await unlink(lockPath).catch(() => undefined);
  }
  return { release };
}
