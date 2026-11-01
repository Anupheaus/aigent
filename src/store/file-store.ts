import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createAigentError } from '../core/aigent-error.js';
import { acquireFileLock } from './file-lock.js';
import { encodeName } from './key-encoding.js';
import { checkWhere, matchesWhere } from './list-where.js';
import { matchesPurge } from './purge-match.js';
import type { CompareAndSetParams, ListOptions, PurgeFilter, Store, StoredRecord } from './store-types.js';

export interface FileStoreOptions {
  /** Directory holding the store; created when missing. One sub-directory per collection. */
  dir: string;
  /** How long a write waits for another writer's lock. Default 10 000. */
  lockTimeoutMs?: number;
  /** A lock older than this is presumed left by a crashed process. Default 30 000. */
  staleLockMs?: number;
  clock?(): number;
  sleep?(delayMs: number): Promise<void>;
  /** Test hook: runs after the new record is fully written to a temporary file and before it replaces the old one. */
  beforeCommit?(): Promise<void>;
}

export interface FileStore extends Store {
  delete(collection: string, key: string): Promise<void>;
  purge(filter: PurgeFilter): Promise<number>;
  /** Present so every store can be closed alike; the file store holds no handles between calls. */
  close(): Promise<void>;
}

/** On-disk record shape; `schemaVersion` lets a later release read older files. */
interface RecordFile {
  schemaVersion: number;
  key: string;
  version: number;
  value: unknown;
}

const RECORD_SCHEMA_VERSION = 1;
const RECORD_SUFFIX = '.json';
const TEMP_SUFFIX = '.tmp';
const LOCK_SUFFIX = '.lock';
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const RENAME_ATTEMPTS = 20;
const RENAME_RETRY_MS = 5;
/** A record's temporary file: `<record file>.<uuid>.tmp` (lock and break files never end this way). */
const TEMP_NAME = /^(.+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
/** Windows refuses to replace a file another process has open for a moment. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

function realSleep(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

/** Makes a rename durable. Windows cannot open a directory for flushing (NTFS journals the rename itself). */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function storeFailed(message: string, details: Record<string, unknown>): Error {
  return createAigentError({ code: 'store_failed', message, details });
}

function parseRecord(text: string, path: string): RecordFile {
  let parsed: Partial<RecordFile>;
  try {
    parsed = JSON.parse(text) as Partial<RecordFile>;
  } catch (error) {
    throw storeFailed(`Record file '${path}' is not valid JSON (${(error as Error).message}); it was not written by this store or was edited by hand`, { path });
  }
  if (typeof parsed.key !== 'string' || typeof parsed.version !== 'number') {
    throw storeFailed(`Record file '${path}' lacks a string 'key' or a numeric 'version'`, { path });
  }
  return parsed as RecordFile;
}

/** A multi-process-safe store keeping one JSON file per record; values must be JSON-serialisable. */
export function createFileStore(options: FileStoreOptions): FileStore {
  const { dir, beforeCommit } = options;
  const lockOptions = {
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    staleLockMs: options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
    clock: options.clock ?? Date.now,
    sleep: options.sleep ?? realSleep,
  };

  const collectionDir = (collection: string): string => join(dir, encodeName(collection));
  const recordPath = (collection: string, key: string): string => join(collectionDir(collection), `${encodeName(key)}${RECORD_SUFFIX}`);

  async function readRecord(path: string): Promise<RecordFile | undefined> {
    try {
      return parseRecord(await readFile(path, 'utf8'), path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  async function replaceFile(temporaryPath: string, path: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(temporaryPath, path);
        return;
      } catch (error) {
        const code = errorCode(error);
        if (attempt >= RENAME_ATTEMPTS || code == null || !TRANSIENT_RENAME_CODES.has(code)) throw error;
        await lockOptions.sleep(RENAME_RETRY_MS);
      }
    }
  }

  /** Writes to a temporary file, flushes it to disk, then renames it over the record so readers never see half a file. */
  async function writeRecord(path: string, record: RecordFile): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}${TEMP_SUFFIX}`;
    try {
      const handle = await open(temporaryPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await beforeCommit?.();
      await replaceFile(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    // The record is committed either way; a directory that cannot be flushed only weakens durability across a power cut.
    await syncDirectory(dirname(path)).catch(() => undefined);
  }

  /**
   * Temporary files of `path` exist only while its lock is held, so once a crashed holder's lock was taken over, any
   * left beside the record are that holder's leftovers.
   */
  async function sweepTemporaries(path: string): Promise<void> {
    const recordName = basename(path);
    for (const name of await readdir(dirname(path)).catch(() => [])) {
      if (TEMP_NAME.exec(name)?.[1] === recordName) await unlink(join(dirname(path), name)).catch(() => undefined);
    }
  }

  async function withLock<R>(path: string, action: () => Promise<R>): Promise<R> {
    await mkdir(join(path, '..'), { recursive: true });
    const lock = await acquireFileLock(`${path}${LOCK_SUFFIX}`, lockOptions);
    try {
      if (lock.tookOver) await sweepTemporaries(path);
      return await action();
    } finally {
      await lock.release();
    }
  }

  async function get<T>(collection: string, key: string): Promise<StoredRecord<T> | undefined> {
    const record = await readRecord(recordPath(collection, key));
    return record == null ? undefined : { key: record.key, value: record.value as T, version: record.version };
  }

  async function compareAndSet<T>(params: CompareAndSetParams<T>): Promise<boolean> {
    const { collection, key, expectedVersion, value } = params;
    const path = recordPath(collection, key);
    return withLock(path, async () => {
      const current = await readRecord(path);
      if (current?.version !== expectedVersion) return false;
      // JSON round trip up front: a value that cannot be stored fails here, before anything touches the disk.
      const serialisable = JSON.parse(JSON.stringify(value ?? null)) as unknown;
      await writeRecord(path, { schemaVersion: RECORD_SCHEMA_VERSION, key, version: (current?.version ?? 0) + 1, value: serialisable });
      return true;
    });
  }

  async function recordFiles(collection: string): Promise<string[]> {
    try {
      const names = await readdir(collectionDir(collection));
      return names.filter(name => name.endsWith(RECORD_SUFFIX)).map(name => join(collectionDir(collection), name));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  /** Every record file is still read (there is no index); `where` only filters what is returned. */
  async function list<T>(collection: string, options: ListOptions = {}): Promise<StoredRecord<T>[]> {
    const { where } = options;
    checkWhere(where);
    const records: StoredRecord<T>[] = [];
    for (const path of await recordFiles(collection)) {
      const record = await readRecord(path);
      // A record deleted between the directory read and this read is simply absent.
      if (record != null && matchesWhere({ value: record.value, where })) records.push({ key: record.key, value: record.value as T, version: record.version });
    }
    return records;
  }

  async function deleteRecord(collection: string, key: string): Promise<void> {
    const path = recordPath(collection, key);
    try {
      await withLock(path, () => rm(path, { force: true }));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  async function purge(filter: PurgeFilter): Promise<number> {
    let purged = 0;
    let collections: string[];
    try {
      collections = await readdir(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 0;
      throw error;
    }
    for (const encodedCollection of collections) {
      let names: string[];
      try {
        names = (await readdir(join(dir, encodedCollection))).filter(name => name.endsWith(RECORD_SUFFIX));
      } catch (error) {
        if (errorCode(error) === 'ENOTDIR' || errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      for (const name of names) {
        const path = join(dir, encodedCollection, name);
        const record = await readRecord(path);
        if (record == null || !matchesPurge(record.value, filter)) continue;
        await withLock(path, async () => {
          // Re-read under the lock: a writer may have replaced the record since the unlocked read above.
          const latest = await readRecord(path);
          if (latest == null || !matchesPurge(latest.value, filter)) return;
          await rm(path, { force: true });
          purged += 1;
        });
      }
    }
    return purged;
  }

  async function close(): Promise<void> {
    // Nothing is held open between calls.
  }

  return { get, compareAndSet, list, delete: deleteRecord, purge, close };
}
