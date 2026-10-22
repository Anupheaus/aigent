import { createAigentError, isAigentError } from '../../../core/aigent-error.js';
import { raceSignal } from '../../../core/race-signal.js';
import type { DbAccess, DbCountParams, DbFindParams, DbFindResult } from './db-access.js';
import { toTaggedJson } from './tagged-json.js';

/** The part of the driver's `FindCursor` the adapter uses. */
export interface MongoCursorLike {
  next(): Promise<Record<string, unknown> | null>;
  close(): Promise<void>;
}

/** The options the adapter passes to `Collection.find`. */
export interface MongoFindOptions {
  projection?: Record<string, 0 | 1>;
  sort?: [string, 1 | -1][];
  limit: number;
  skip?: number;
  maxTimeMS: number;
}

/** The part of the driver's `Collection` the adapter uses: `find` and `countDocuments`, nothing else. */
export interface MongoCollectionLike {
  find(filter: Record<string, unknown>, options: MongoFindOptions): MongoCursorLike;
  countDocuments(filter: Record<string, unknown>, options: { maxTimeMS: number }): Promise<number>;
}

/** The part of the driver's `Db` the adapter uses (`client.db(name)`). */
export interface MongoDbLike {
  collection(name: string): MongoCollectionLike;
}

/** Builds driver values for tagged literals in filters (`{ $oid }`, `{ $numberDecimal }`). */
export interface MongoBsonFactories {
  objectId(hex: string): unknown;
  decimal128(text: string): unknown;
}

/** `createMongoDbAccess(options)`. */
export interface MongoDbAccessOptions {
  db: MongoDbLike;
  /** Default: `ObjectId` and `Decimal128` from the `mongodb` package (an optional peer dependency, loaded on first need). */
  bson?: MongoBsonFactories;
}

/** The driver package, named through a variable so it stays an optional peer the compiler never resolves. */
const DRIVER_PACKAGE = 'mongodb';
/** `scheme://user:password@` in connection strings the driver may echo in errors. */
const URI_CREDENTIALS = /([a-z][\w+.-]*:\/\/)[^@\s/]+@/gi;

interface DriverModule {
  ObjectId: new (hex: string) => unknown;
  Decimal128: { fromString(text: string): unknown };
}

async function loadDriverBson(): Promise<MongoBsonFactories> {
  try {
    const driver = (await import(DRIVER_PACKAGE)) as unknown as DriverModule;
    return { objectId: hex => new driver.ObjectId(hex), decimal128: text => driver.Decimal128.fromString(text) };
  } catch (error) {
    throw createAigentError({ code: 'invalid_definition', message: `createMongoDbAccess needs the 'mongodb' package (an optional peer dependency) or a bson option: ${error instanceof Error ? error.message : String(error)}` });
  }
}

/** The filter with tagged literals turned into driver values. */
function toDriverFilter(params: { value: unknown; bson?: MongoBsonFactories }): unknown {
  const { value, bson } = params;
  if (Array.isArray(value)) return value.map(element => toDriverFilter({ value: element, ...(bson == null ? {} : { bson }) }));
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value);
  const [first] = entries;
  if (entries.length === 1 && first != null) {
    const [key, literal] = first;
    if (key === '$oid' && bson != null) return bson.objectId(literal as string);
    if (key === '$date') return new Date(literal as string | number);
    if (key === '$numberDecimal' && bson != null) return bson.decimal128(literal as string);
  }
  return Object.fromEntries(entries.map(([key, child]) => [key, toDriverFilter({ value: child, ...(bson == null ? {} : { bson }) })]));
}

/** Whether the filter holds a literal only the driver's own types can carry. */
function needsBson(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, child]) => key === '$oid' || key === '$numberDecimal' || needsBson(child));
}

/** A driver failure without credentials (connection strings are echoed in some errors). */
function databaseError(error: unknown): Error {
  if (isAigentError(error)) return error;
  const message = (error instanceof Error ? error.message : String(error)).replace(URI_CREDENTIALS, '$1[REDACTED]@');
  return createAigentError({ code: 'provider_failed', message: `Database query failed: ${message}` });
}

function aborted(collection: string): Error {
  return createAigentError({ code: 'aborted', message: `The query on '${collection}' was stopped because the run was stopped`, details: { collection } });
}

/**
 * A `DbAccess` over the MongoDB driver: `collection.find` with `maxTimeMS` (never `aggregate`, never a write) and
 * `countDocuments`. Documents come back as tagged JSON (`toTaggedJson`); the cursor is closed in every case.
 */
export function createMongoDbAccess(options: MongoDbAccessOptions): DbAccess {
  const { db } = options;
  let bson: Promise<MongoBsonFactories> | undefined = options.bson == null ? undefined : Promise.resolve(options.bson);
  const driverFilter = async (filter: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (needsBson(filter)) bson ??= loadDriverBson();
    return toDriverFilter({ value: filter, ...(bson == null ? {} : { bson: await bson }) }) as Record<string, unknown>;
  };
  const find = async (params: DbFindParams): Promise<DbFindResult> => {
    const { collection, filter, projection, sort, limit, skip, maxTimeMs, signal } = params;
    if (signal.aborted) throw aborted(collection);
    let cursor: MongoCursorLike | undefined;
    try {
      const findOptions: MongoFindOptions = {
        ...(projection == null ? {} : { projection }),
        ...(sort == null ? {} : { sort: sort.map(({ field, direction }): [string, 1 | -1] => [field, direction === 'asc' ? 1 : -1]) }),
        // One more than asked shows whether more documents matched.
        limit: limit + 1, ...(skip == null ? {} : { skip }), maxTimeMS: maxTimeMs,
      };
      cursor = db.collection(collection).find(await driverFilter(filter), findOptions);
      const docs: Record<string, unknown>[] = [];
      while (docs.length <= limit) {
        const next = await raceSignal({ work: cursor.next(), signal });
        if (next.isAborted) throw aborted(collection);
        if (next.value == null) break;
        docs.push(toTaggedJson(next.value) as Record<string, unknown>);
      }
      return { docs: docs.slice(0, limit), truncated: docs.length > limit };
    } catch (error) {
      throw databaseError(error);
    } finally {
      // A failed close must not hide the query's own result or error.
      await cursor?.close().catch(() => undefined);
    }
  };
  const count = async (params: DbCountParams): Promise<number> => {
    const { collection, filter, maxTimeMs, signal } = params;
    if (signal.aborted) throw aborted(collection);
    try {
      const counted = await raceSignal({ work: db.collection(collection).countDocuments(await driverFilter(filter), { maxTimeMS: maxTimeMs }), signal });
      if (counted.isAborted) throw aborted(collection);
      return counted.value;
    } catch (error) {
      throw databaseError(error);
    }
  };
  return { find, count };
}
