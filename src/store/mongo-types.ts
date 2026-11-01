/** A record's purge criteria, copied out of its value (only when the value is a plain object) so a filter can reach them. */
export interface MongoPurgeFields {
  agentName?: string;
  runId?: string;
  recordedAt?: number;
}

/**
 * A stored document: the record key is the `_id` and the value is JSON text, so any JSON value round-trips whatever
 * its field names (`$schema`, `a.b`), which MongoDB would refuse or misread as stored fields.
 */
export interface MongoDocument {
  _id: string;
  version: number;
  /** The value as `JSON.stringify` wrote it. */
  json: string;
  /** The collection prefix of the store that wrote it: `purge` never touches another store's records. */
  store: string;
  /** Null when the value is not a plain object (no purge criterion ever matches it). */
  purge: MongoPurgeFields | null;
  /**
   * The value's short top-level scalars (see `whereFieldsOf`), so `list({ where })` can filter on the server; null when
   * the value is not a plain object. Absent on documents written before the store had it.
   */
  fields?: MongoWhereFields | null;
}

/** Top-level fields copied out of a value for `list` filters. */
export type MongoWhereFields = Record<string, string | number | boolean | null>;

/**
 * Filters the store sends: `{ _id }`, `{ _id, version }`, `{}`, the purge criteria on `store` and `purge.*`
 * (`$lt` only on `purge.recordedAt`, `$type: 'object'` only on `purge`), or a list filter: `$or` of equalities on
 * `fields.*` and `{ fields: { $exists: false } }`.
 */
export type MongoFilter = Record<string, unknown>;

/** What a conditional update changes. */
export interface MongoUpdate {
  $set: Pick<MongoDocument, 'version' | 'json' | 'purge' | 'fields'>;
}

/** The few `mongodb` Collection methods the store uses, so a fake can stand in and the driver stays an optional peer. */
export interface MongoCollectionLike {
  findOne(filter: MongoFilter): Promise<MongoDocument | null>;
  find(filter: MongoFilter): { toArray(): Promise<MongoDocument[]> };
  /** Rejects with an error whose `code` is 11000 when the `_id` exists. */
  insertOne(document: MongoDocument): Promise<unknown>;
  updateOne(filter: MongoFilter, update: MongoUpdate): Promise<{ matchedCount: number }>;
  deleteOne(filter: MongoFilter): Promise<{ deletedCount: number }>;
  deleteMany(filter: MongoFilter): Promise<{ deletedCount: number }>;
  createIndex(keys: Record<string, 1 | -1>): Promise<unknown>;
}

/** One `listCollections` entry: `type` is `collection` or `view`. */
export interface MongoCollectionInfo {
  name: string;
  type?: string;
}

export interface MongoDbLike {
  collection(name: string): MongoCollectionLike;
  listCollections(filter: MongoFilter): { toArray(): Promise<MongoCollectionInfo[]> };
}
