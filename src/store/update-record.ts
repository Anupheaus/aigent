import { createAigentError } from '../core/aigent-error.js';
import type { Store } from './store-types.js';

export interface UpdateRecordParams<T> {
  store: Store;
  collection: string;
  key: string;
  /**
   * Builds the next value from the current one (undefined when the record does not exist). May run several times, and
   * may be async (to read other records): it runs after the current value is read and before the compare-and-set, so
   * anything it reads is re-read whenever another write lands first.
   */
  update(current: T | undefined): T | Promise<T>;
  /** Attempts before giving up with `store_conflict`. Default 50. */
  maxAttempts?: number;
  /** Waits between attempts; injectable so tests need not wait. Defaults to a real timer. */
  sleep?(delayMs: number): Promise<void>;
}

/**
 * Each failed compare-and-set means another updater's write landed in between, so N contenders on one key need at most
 * N attempts each. 50 covers well over the 25 concurrent in-process updaters the library is expected to handle.
 */
const DEFAULT_MAX_ATTEMPTS = 50;
/** First backoff ceiling; doubles per attempt up to `MAX_BACKOFF_MS`. */
const BASE_BACKOFF_MS = 2;
/** Longest wait between two attempts. */
const MAX_BACKOFF_MS = 50;

function realSleep(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

/** "Full jitter" backoff: a random wait up to a ceiling that grows with the attempt, so contenders spread out instead of colliding again. */
function backoffMs(attempt: number): number {
  const ceilingMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return Math.random() * ceilingMs;
}

/**
 * Read-modify-write with compare-and-set retry, so concurrent updaters never lose each other's changes.
 * Between attempts it waits a small jittered backoff. Throws `store_conflict` after `maxAttempts` failed attempts.
 */
export async function updateRecord<T>(params: UpdateRecordParams<T>): Promise<T> {
  const { store, collection, key, update, maxAttempts = DEFAULT_MAX_ATTEMPTS, sleep = realSleep } = params;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const current = await store.get<T>(collection, key);
    const next = await update(current?.value);
    if (await store.compareAndSet({ collection, key, expectedVersion: current?.version, value: next })) return next;
    if (attempt < maxAttempts) await sleep(backoffMs(attempt));
  }
  throw createAigentError({
    code: 'store_conflict',
    message: `Could not update '${collection}/${key}' after ${maxAttempts} attempts because of concurrent writes; retry later or raise maxAttempts`,
    details: { collection, key, maxAttempts },
  });
}
