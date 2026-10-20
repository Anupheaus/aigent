import { createAigentError } from '../core/aigent-error.js';
import type { Store } from './store-types.js';

export interface UpdateRecordParams<T> {
  store: Store;
  collection: string;
  key: string;
  update(current: T | undefined): T;
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 10;

/** Read-modify-write with compare-and-set retry, so concurrent updaters never lose each other's changes. */
export async function updateRecord<T>(params: UpdateRecordParams<T>): Promise<T> {
  const { store, collection, key, update, maxAttempts = DEFAULT_MAX_ATTEMPTS } = params;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const current = await store.get<T>(collection, key);
    const next = update(current?.value);
    if (await store.compareAndSet({ collection, key, expectedVersion: current?.version, value: next })) return next;
  }
  throw createAigentError({
    code: 'store_conflict',
    message: `Could not update '${collection}/${key}' after ${maxAttempts} attempts because of concurrent writes`,
    details: { collection, key, maxAttempts },
  });
}
