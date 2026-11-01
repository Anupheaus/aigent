import { createAigentError } from '../core/aigent-error.js';
import { encodeName } from './key-encoding.js';
import { documentFor, purgeCriteria, valueOf } from './mongo-document.js';
import type { MongoCollectionLike, MongoDbLike } from './mongo-types.js';
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
const DUPLICATE_KEY_CODE = 11_000;
/** The server gave up on the write because another one touched the document: the compare-and-set lost. */
const WRITE_CONFLICT_CODE = 112;
/** `purge` deletes from collections only (a view cannot be written to). */
const COLLECTIONS_ONLY = { type: 'collection' };
const FIRST_VERSION = 1;
const RETRYABLE_ERROR_NAMES = /Network|Timeout|ServerSelection|PoolCleared/;
const RETRYABLE_LABELS = ['RetryableWriteError', 'TransientTransactionError'];

/** A surrogate code unit without its partner: BSON strings are UTF-8, which turns it into U+FFFD. */
const LONE_SURROGATE = /\p{Cs}/u;

/** Refuses a key the server would silently change into another one (and so mix two records up); collection names are encoded. */
function checkWellFormed(params: { collection: string; key: string }): void {
  const { collection, key } = params;
  if (!LONE_SURROGATE.test(key)) return;
  throw createAigentError({
    code: 'invalid_input',
    message: `MongoDB store key ${JSON.stringify(key)} in collection '${collection}' has a lone surrogate, which MongoDB would store as U+FFFD; use well-formed Unicode`,
    details: { collection, key },
  });
}

function errorCodeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

/** Another writer got there first: the create found the key taken, or the update conflicted. */
function isLostRace(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === DUPLICATE_KEY_CODE || code === WRITE_CONFLICT_CODE;
}

function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, errorLabels } = error as { name?: unknown; errorLabels?: unknown };
  if (typeof name === 'string' && RETRYABLE_ERROR_NAMES.test(name)) return true;
  return Array.isArray(errorLabels) && errorLabels.some(label => RETRYABLE_LABELS.includes(String(label)));
}

/**
 * A store on MongoDB: one collection per logical collection, documents `{ _id: key, version, json, store, purge }`
 * (see `MongoDocument`). Reads never create a collection; the first write creates it with its purge index.
 */
export function createMongoStore(options: MongoStoreOptions): MongoStore {
  const { db, onClose } = options;
  const prefix = options.collectionPrefix ?? DEFAULT_PREFIX;
  const indexed = new Map<string, Promise<void>>();
  let closed = false;

  function mongoName(collection: string): string {
    return `${prefix}${encodeName(collection)}`;
  }

  /** Maps a driver failure to `store_failed`, saying which operation and whether trying again may help. */
  async function guarded<R>(params: { operation: string; details: Record<string, unknown>; action(): Promise<R> }): Promise<R> {
    const { operation, details, action } = params;
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

  /** A write target: its purge index is created once per collection per store (an existing index is a no-op in MongoDB). */
  function writableCollection(collection: string): Promise<MongoCollectionLike> {
    const name = mongoName(collection);
    const target = db.collection(name);
    let pending = indexed.get(name);
    if (pending == null) {
      pending = target.createIndex({ 'purge.recordedAt': 1 }).then(() => undefined);
      indexed.set(name, pending);
      pending.catch(() => indexed.delete(name));
    }
    return pending.then(() => target);
  }

  async function get<T>(collection: string, key: string): Promise<StoredRecord<T> | undefined> {
    checkWellFormed({ collection, key });
    return guarded({
      operation: 'read', details: { collection, key },
      action: async () => {
        const found = await db.collection(mongoName(collection)).findOne({ _id: key });
        return found == null ? undefined : { key, value: valueOf({ document: found, collection }) as T, version: found.version };
      },
    });
  }

  async function compareAndSet<T>(params: CompareAndSetParams<T>): Promise<boolean> {
    const { collection, key, expectedVersion, value } = params;
    checkWellFormed({ collection, key });
    const document = documentFor({ key, version: (expectedVersion ?? 0) + 1, value, prefix, collection });
    return guarded({
      operation: 'write', details: { collection, key },
      action: async () => {
        const target = await writableCollection(collection);
        try {
          if (expectedVersion == null) {
            await target.insertOne(document);
            return true;
          }
          const { version, json, purge } = document;
          const result = await target.updateOne({ _id: key, version: expectedVersion }, { $set: { version, json, purge } });
          return result.matchedCount === 1;
        } catch (error) {
          if (isLostRace(error)) return false;
          throw error;
        }
      },
    });
  }

  async function list<T>(collection: string): Promise<StoredRecord<T>[]> {
    return guarded({
      operation: 'list', details: { collection },
      action: async () => {
        const documents = await db.collection(mongoName(collection)).find({}).toArray();
        return documents.map(document => ({ key: document._id, value: valueOf({ document, collection }) as T, version: document.version }));
      },
    });
  }

  async function deleteRecord(collection: string, key: string): Promise<void> {
    checkWellFormed({ collection, key });
    await guarded({
      operation: 'delete', details: { collection, key },
      action: async () => {
        await db.collection(mongoName(collection)).deleteOne({ _id: key });
      },
    });
  }

  async function purge(filter: PurgeFilter): Promise<number> {
    return guarded({
      operation: 'purge', details: {},
      action: async () => {
        // `store` in the criteria: a store whose prefix starts with this one's has collection names this one could own.
        const criteria = purgeCriteria({ filter, prefix });
        let purged = 0;
        for (const { name } of await db.listCollections(COLLECTIONS_ONLY).toArray()) {
          if (!name.startsWith(prefix)) continue;
          purged += (await db.collection(name).deleteMany(criteria)).deletedCount;
        }
        return purged;
      },
    });
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await onClose?.();
  }

  return { get, compareAndSet, list, delete: deleteRecord, purge, close };
}
