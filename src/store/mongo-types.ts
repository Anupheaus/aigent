/** A stored document: the record key is the `_id`, the value sits under `value`. */
export interface MongoDocument {
  _id: string;
  version: number;
  value: unknown;
}

/**
 * Filters the store sends: `{ _id }`, `{ _id, version }`, `{}` or the purge criteria on `value.*`
 * (`$lt` only on `value.recordedAt`).
 */
export type MongoFilter = Record<string, unknown>;

/** The few `mongodb` Collection methods the store uses, so a fake can stand in and the driver stays an optional peer. */
export interface MongoCollectionLike {
  findOne(filter: MongoFilter): Promise<MongoDocument | null>;
  find(filter: MongoFilter): { toArray(): Promise<MongoDocument[]> };
  /** Rejects with an error whose `code` is 11000 when the `_id` exists. */
  insertOne(document: MongoDocument): Promise<unknown>;
  updateOne(filter: MongoFilter, update: { $set: { version: number; value: unknown } }): Promise<{ matchedCount: number }>;
  deleteOne(filter: MongoFilter): Promise<{ deletedCount: number }>;
  deleteMany(filter: MongoFilter): Promise<{ deletedCount: number }>;
  createIndex(keys: Record<string, 1 | -1>): Promise<unknown>;
}

export interface MongoDbLike {
  collection(name: string): MongoCollectionLike;
  listCollections(filter: MongoFilter): { toArray(): Promise<{ name: string }[]> };
}
