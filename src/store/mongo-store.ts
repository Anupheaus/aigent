import { createAigentError } from '../core/aigent-error.js';
import { encodeName } from './key-encoding.js';
import type { MongoCollectionLike, MongoDbLike, MongoFilter } from './mongo-types.js';
import type { CompareAndSetParams, PurgeFilter, Store, StoredRecord } from './store-types.js';

export interface MongoStoreOptions {
  db: MongoDbLike;
  /** Prefix of every collection the store owns, so `purge` and `list` never touch the application's own. Default `aigent_`. */
  collectionPrefix?: string;
  /** Called once by `close()` (for example `() => client.close()`). */
  onClose?(): Promise<void>;
}

export interface MongoStore extends Store {
  delete(collection: string, key: string): Promise<void>;
  purge(filter: PurgeFilter): Promise<number>;
  /** Closes the connection the store was given; later calls fail with `store_failed`. */
  close(): Promise<void>;
}

const DEFAULT_PREFIX = 'aigent_';
const DUPLICATE_KEY_CODE = 11000;
const FIRST_VERSION = 1;
const RETRYABLE_ERROR_NAMES = /Network|Timeout|ServerSelection|PoolCleared/;
const RETRYABLE_LABELS = ['RetryableWriteError', 'TransientTransactionError'];

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === DUPLICATE_KEY_CODE;
}

function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, errorLabels } = error as { name?: unknown; errorLabels?: unknown };
  if (typeof name === 'string' && RETRYABLE_ERROR_NAMES.test(name)) return true;
  return Array.isArray(errorLabels) && errorLabels.some(label => RETRYABLE_LABELS.includes(String(label)));
}

/** A store on MongoDB: one collection per logical collection, documents `{ _id: key, version, value }`. */
export function createMongoStore(options: MongoStoreOptions): MongoStore {
  const { db, onClose } = options;
  const prefix = options.collectionPrefix ?? DEFAULT_PREFIX;
  const indexed = new Map<string, Promise<void>>();
  let closed = false;

  function mongoName(collection: string): string {
    return `${prefix}${encodeName(collection)}`;
  }

  /** Maps a driver failure to `store_failed`, saying which operation and whether trying again may help. */
  async function guarded<R>(operation: string, details: Record<string, unknown>, action: () => Promise<R>): Promise<R> {
    if (closed) {
      throw createAigentError({ code: 'store_failed', message: `Cannot ${operation}: the MongoDB store is closed`, details });
    }
    try {
      return await action();
    } catch (error) {
      throw createAigentError({
        code: 'store_failed',
        message: `MongoDB ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { ...details, retryable: isRetryable(error) },
      });
    }
  }

  /** Creates the purge index once per collection per store; creating an existing index is a no-op in MongoDB. */
  function collectionFor(collection: string): Promise<MongoCollectionLike> {
    const name = mongoName(collection);
    const target = db.collection(name);
    let pending = indexed.get(name);
    if (pending == null) {
      pending = target.createIndex({ 'value.recordedAt': 1 }).then(() => undefined);
      indexed.set(name, pending);
      pending.catch(() => indexed.delete(name));
    }
    return pending.then(() => target);
  }

  async function get<T>(collection: string, key: string): Promise<StoredRecord<T> | undefined> {
    return guarded('read', { collection, key }, async () => {
      const found = await (await collectionFor(collection)).findOne({ _id: key });
      return found == null ? undefined : { key, value: found.value as T, version: found.version };
    });
  }

  async function compareAndSet<T>(params: CompareAndSetParams<T>): Promise<boolean> {
    const { collection, key, expectedVersion, value } = params;
    return guarded('write', { collection, key }, async () => {
      const target = await collectionFor(collection);
      if (expectedVersion == null) {
        try {
          await target.insertOne({ _id: key, version: FIRST_VERSION, value });
          return true;
        } catch (error) {
          if (isDuplicateKey(error)) return false;
          throw error;
        }
      }
      const result = await target.updateOne({ _id: key, version: expectedVersion }, { $set: { version: expectedVersion + 1, value } });
      return result.matchedCount === 1;
    });
  }

  async function list<T>(collection: string): Promise<StoredRecord<T>[]> {
    return guarded('list', { collection }, async () => {
      const documents = await (await collectionFor(collection)).find({}).toArray();
      return documents.map(document => ({ key: document._id, value: document.value as T, version: document.version }));
    });
  }

  async function deleteRecord(collection: string, key: string): Promise<void> {
    await guarded('delete', { collection, key }, async () => {
      await (await collectionFor(collection)).deleteOne({ _id: key });
    });
  }

  function purgeFilter(filter: PurgeFilter): MongoFilter {
    const { agentName, runId, before } = filter;
    const criteria: MongoFilter = {};
    if (agentName != null) criteria['value.agentName'] = agentName;
    if (runId != null) criteria['value.runId'] = runId;
    if (before != null) criteria['value.recordedAt'] = { $lt: before };
    return criteria;
  }

  async function purge(filter: PurgeFilter): Promise<number> {
    return guarded('purge', {}, async () => {
      // As in the other stores, an empty filter matches every record whose value is an object (never a bare string or array).
      const criteria = Object.keys(purgeFilter(filter)).length === 0 ? { value: { $type: 'object' } } : purgeFilter(filter);
      const names = await db.listCollections({}).toArray();
      let purged = 0;
      for (const { name } of names) {
        if (!name.startsWith(prefix)) continue;
        purged += (await db.collection(name).deleteMany(criteria)).deletedCount;
      }
      return purged;
    });
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await onClose?.();
  }

  return { get, compareAndSet, list, delete: deleteRecord, purge, close };
}
