import type { MongoCollectionLike, MongoDbLike, MongoDocument, MongoFilter } from './mongo-types.js';

/** The only operations the store may call; the fake counts them so a test can pin the set. */
export type MongoOperation = 'findOne' | 'find' | 'insertOne' | 'updateOne' | 'deleteOne' | 'deleteMany' | 'createIndex' | 'listCollections';

export interface MongoFake {
  db: MongoDbLike;
  /** Every operation called, in order, with the collection it targeted. */
  calls: { operation: MongoOperation; collection: string }[];
  /** Makes the next operation of this kind reject with `error` (once). */
  failNext(operation: MongoOperation, error: unknown): void;
  /** Collections the fake created an index on, with the keys. */
  indexes: Map<string, Record<string, 1 | -1>[]>;
}

const DUPLICATE_KEY_CODE = 11000;

function duplicateKeyError(id: string): Error {
  return Object.assign(new Error(`E11000 duplicate key error: _id ${id}`), { code: DUPLICATE_KEY_CODE });
}

/**
 * What a value becomes on its way through the driver: BSON strings are UTF-8 (a lone surrogate turns into U+FFFD)
 * and `undefined` is stored as `null`.
 */
function asBson(value: unknown): unknown {
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('utf8');
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(asBson);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([field, nested]) => [asBson(field) as string, asBson(nested)]));
  return value;
}

function valueAt(document: MongoDocument, path: string): unknown {
  let current: unknown = document;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function matchesCondition(actual: unknown, condition: unknown): boolean {
  if (typeof condition === 'object' && condition !== null) {
    const operators = condition as Record<string, unknown>;
    if ('$lt' in operators) return typeof actual === 'number' && typeof operators.$lt === 'number' && actual < operators.$lt;
    if ('$type' in operators) return operators.$type === 'object' && typeof actual === 'object' && actual !== null && !Array.isArray(actual);
    throw new Error(`mongo fake: unsupported operator in ${JSON.stringify(condition)}`);
  }
  return actual === condition;
}

function matches(document: MongoDocument, filter: MongoFilter): boolean {
  return Object.entries(asBson(filter) as MongoFilter).every(([path, condition]) => matchesCondition(valueAt(document, path), condition));
}

/** A faithful in-memory stand-in for the subset of the MongoDB driver the store uses (duplicate-key errors, conditional updates). */
export function createMongoFake(): MongoFake {
  const collections = new Map<string, Map<string, MongoDocument>>();
  const calls: MongoFake['calls'] = [];
  const indexes = new Map<string, Record<string, 1 | -1>[]>();
  const failures = new Map<MongoOperation, unknown[]>();

  function record(operation: MongoOperation, collection: string): void {
    calls.push({ operation, collection });
  }

  async function maybeFail(operation: MongoOperation): Promise<void> {
    const queue = failures.get(operation);
    if (queue != null && queue.length > 0) throw queue.shift();
    // A real driver never completes synchronously; yielding lets concurrent callers interleave as they would.
    await Promise.resolve();
  }

  function documentsOf(name: string): Map<string, MongoDocument> {
    const existing = collections.get(name);
    if (existing != null) return existing;
    const created = new Map<string, MongoDocument>();
    collections.set(name, created);
    return created;
  }

  function collection(name: string): MongoCollectionLike {
    return {
      async findOne(filter) {
        record('findOne', name);
        await maybeFail('findOne');
        const found = [...documentsOf(name).values()].find(document => matches(document, filter));
        return found == null ? null : structuredClone(found);
      },
      find(filter) {
        record('find', name);
        return {
          async toArray() {
            await maybeFail('find');
            return [...documentsOf(name).values()].filter(document => matches(document, filter)).map(document => structuredClone(document));
          },
        };
      },
      async insertOne(document) {
        record('insertOne', name);
        await maybeFail('insertOne');
        const documents = documentsOf(name);
        const stored = asBson(document) as MongoDocument;
        if (documents.has(stored._id)) throw duplicateKeyError(stored._id);
        documents.set(stored._id, stored);
        return { acknowledged: true };
      },
      async updateOne(filter, update) {
        record('updateOne', name);
        await maybeFail('updateOne');
        const found = [...documentsOf(name).values()].find(document => matches(document, filter));
        if (found == null) return { matchedCount: 0 };
        found.version = update.$set.version;
        found.value = asBson(update.$set.value);
        return { matchedCount: 1 };
      },
      async deleteOne(filter) {
        record('deleteOne', name);
        await maybeFail('deleteOne');
        const found = [...documentsOf(name).values()].find(document => matches(document, filter));
        if (found == null) return { deletedCount: 0 };
        documentsOf(name).delete(found._id);
        return { deletedCount: 1 };
      },
      async deleteMany(filter) {
        record('deleteMany', name);
        await maybeFail('deleteMany');
        const documents = documentsOf(name);
        const doomed = [...documents.values()].filter(document => matches(document, filter));
        for (const document of doomed) documents.delete(document._id);
        return { deletedCount: doomed.length };
      },
      async createIndex(keys) {
        record('createIndex', name);
        await maybeFail('createIndex');
        const existing = indexes.get(name) ?? [];
        // Creating an index that already exists changes nothing, as in MongoDB.
        if (!existing.some(known => JSON.stringify(known) === JSON.stringify(keys))) existing.push(keys);
        indexes.set(name, existing);
        documentsOf(name);
        return 'index';
      },
    };
  }

  const db: MongoDbLike = {
    collection,
    listCollections() {
      record('listCollections', '');
      return {
        async toArray() {
          await maybeFail('listCollections');
          return [...collections.keys()].map(name => ({ name }));
        },
      };
    },
  };

  return {
    db,
    calls,
    indexes,
    failNext(operation, error) {
      failures.set(operation, [...(failures.get(operation) ?? []), error]);
    },
  };
}
