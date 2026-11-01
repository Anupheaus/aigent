import { MAX_BSON_DOCUMENT_BYTES, bsonSize } from './bson-size.js';
import type { MongoCollectionInfo, MongoCollectionLike, MongoDbLike, MongoDocument, MongoFilter } from './mongo-types.js';

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
  /** Adds a view: listed with `type: 'view'`, and writes to it fail as on a server. */
  createView(name: string): void;
}

type StoredDocument = Record<string, unknown> & { _id: string };

const DUPLICATE_KEY_CODE = 11_000;
/** Server error codes for the refusals the fake reproduces. */
const DOLLAR_PREFIXED_FIELD_CODE = 52;
const DOCUMENT_TOO_LARGE_CODE = 10_334;
const COMMAND_NOT_SUPPORTED_ON_VIEW_CODE = 166;
const COLLECTION_TYPE = 'collection';
const VIEW_TYPE = 'view';

function serverError(params: { message: string; code: number }): Error {
  const { message, code } = params;
  return Object.assign(new Error(message), { name: 'MongoServerError', code });
}

/**
 * What a value becomes on its way through the driver: BSON strings are UTF-8 (a lone surrogate turns into U+FFFD)
 * and `undefined` is stored as `null`. Field names holding a NUL byte cannot be written at all.
 */
function asBson(value: unknown): unknown {
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('utf8');
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(asBson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([field, nested]) => {
    if (field.includes('\0')) throw Object.assign(new Error(`BSON field names cannot contain null bytes, found: ${JSON.stringify(field)}`), { name: 'BSONError' });
    return [asBson(field) as string, asBson(nested)];
  }));
}

/** The first `$`-prefixed field name under `value`, with its path; MongoDB refuses them in an update's values. */
function dollarField(params: { value: unknown; path: string }): string | undefined {
  const { value, path } = params;
  if (typeof value !== 'object' || value === null) return undefined;
  for (const [field, nested] of Object.entries(value)) {
    const nestedPath = `${path}.${field}`;
    if (field.startsWith('$')) return nestedPath;
    const found = dollarField({ value: nested, path: nestedPath });
    if (found != null) return found;
  }
  return undefined;
}

function checkSize(document: StoredDocument): void {
  const size = bsonSize(document);
  if (size > MAX_BSON_DOCUMENT_BYTES) throw serverError({ message: `BSONObj size: ${size} is invalid. Size must be between 0 and ${MAX_BSON_DOCUMENT_BYTES}(16MB)`, code: DOCUMENT_TOO_LARGE_CODE });
}

/** Every value a dotted path reaches; like the server, a path walks into each element of an array it meets. */
function valuesAt(params: { value: unknown; parts: string[] }): unknown[] {
  const { value, parts } = params;
  const [part, ...rest] = parts;
  if (part == null) return Array.isArray(value) ? [value, ...value] : [value];
  if (Array.isArray(value)) return value.flatMap(element => valuesAt({ value: element, parts }));
  if (typeof value !== 'object' || value === null) return [undefined];
  return valuesAt({ value: (value as Record<string, unknown>)[part], parts: rest });
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

function matches(document: StoredDocument, filter: MongoFilter): boolean {
  return Object.entries(asBson(filter) as MongoFilter).every(([path, condition]) => (
    valuesAt({ value: document, parts: path.split('.') }).some(actual => matchesCondition(actual, condition))
  ));
}

function copyOut(document: StoredDocument): MongoDocument {
  return structuredClone(document) as unknown as MongoDocument;
}

/**
 * A faithful in-memory stand-in for the subset of the MongoDB driver the store uses: duplicate-key errors,
 * conditional updates, UTF-8 strings, the 16 MiB document limit, `$`-prefixed fields refused in updates, paths
 * through arrays, views, and reads that never create a collection.
 */
export function createMongoFake(): MongoFake {
  const collections = new Map<string, Map<string, StoredDocument>>();
  const views = new Set<string>();
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

  /** A write target: created on first write, as the server does; a view cannot be written. */
  function writableDocumentsOf(name: string): Map<string, StoredDocument> {
    if (views.has(name)) throw serverError({ message: `Namespace ${name} is a view, not a collection`, code: COMMAND_NOT_SUPPORTED_ON_VIEW_CODE });
    const existing = collections.get(name);
    if (existing != null) return existing;
    const created = new Map<string, StoredDocument>();
    collections.set(name, created);
    return created;
  }

  function readableDocumentsOf(name: string): StoredDocument[] {
    return [...collections.get(name)?.values() ?? []];
  }

  function collection(name: string): MongoCollectionLike {
    return {
      async findOne(filter) {
        record('findOne', name);
        await maybeFail('findOne');
        const found = readableDocumentsOf(name).find(document => matches(document, filter));
        return found == null ? null : copyOut(found);
      },
      find(filter) {
        record('find', name);
        return {
          async toArray() {
            await maybeFail('find');
            return readableDocumentsOf(name).filter(document => matches(document, filter)).map(copyOut);
          },
        };
      },
      async insertOne(document) {
        record('insertOne', name);
        await maybeFail('insertOne');
        const stored = asBson(document) as StoredDocument;
        const topLevelDollar = Object.keys(stored).find(field => field.startsWith('$'));
        if (topLevelDollar != null) throw serverError({ message: `Document can't have $ prefixed field names: ${topLevelDollar}`, code: DOLLAR_PREFIXED_FIELD_CODE });
        checkSize(stored);
        const documents = writableDocumentsOf(name);
        if (documents.has(stored._id)) throw serverError({ message: `E11000 duplicate key error: _id ${stored._id}`, code: DUPLICATE_KEY_CODE });
        documents.set(stored._id, stored);
        return { acknowledged: true };
      },
      async updateOne(filter, update) {
        record('updateOne', name);
        await maybeFail('updateOne');
        const changes = asBson(update.$set) as Record<string, unknown>;
        const dollar = dollarField({ value: changes, path: '' });
        if (dollar != null) {
          const field = dollar.split('.').pop() ?? dollar;
          throw serverError({ message: `The dollar ($) prefixed field '${field}' in '${dollar.slice(1)}' is not allowed in the context of an update's replacement document.`, code: DOLLAR_PREFIXED_FIELD_CODE });
        }
        const documents = writableDocumentsOf(name);
        const found = [...documents.values()].find(document => matches(document, filter));
        if (found == null) return { matchedCount: 0 };
        const updated: StoredDocument = { ...found, ...changes };
        checkSize(updated);
        documents.set(found._id, updated);
        return { matchedCount: 1 };
      },
      async deleteOne(filter) {
        record('deleteOne', name);
        await maybeFail('deleteOne');
        const documents = writableDocumentsOf(name);
        const found = [...documents.values()].find(document => matches(document, filter));
        if (found == null) return { deletedCount: 0 };
        documents.delete(found._id);
        return { deletedCount: 1 };
      },
      async deleteMany(filter) {
        record('deleteMany', name);
        await maybeFail('deleteMany');
        const documents = writableDocumentsOf(name);
        const doomed = [...documents.values()].filter(document => matches(document, filter));
        for (const document of doomed) documents.delete(document._id);
        return { deletedCount: doomed.length };
      },
      async createIndex(keys) {
        record('createIndex', name);
        await maybeFail('createIndex');
        writableDocumentsOf(name);
        const existing = indexes.get(name) ?? [];
        // Creating an index that already exists changes nothing, as in MongoDB.
        if (!existing.some(known => JSON.stringify(known) === JSON.stringify(keys))) existing.push(keys);
        indexes.set(name, existing);
        return 'index';
      },
    };
  }

  const db: MongoDbLike = {
    collection,
    listCollections(filter) {
      record('listCollections', '');
      return {
        async toArray() {
          await maybeFail('listCollections');
          const all: MongoCollectionInfo[] = [
            ...[...collections.keys()].map(name => ({ name, type: COLLECTION_TYPE })),
            ...[...views].map(name => ({ name, type: VIEW_TYPE })),
          ];
          const { type } = filter as { type?: unknown };
          return type == null ? all : all.filter(info => info.type === type);
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
    createView(name) {
      views.add(name);
    },
  };
}
