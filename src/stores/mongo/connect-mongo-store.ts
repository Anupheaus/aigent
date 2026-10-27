import { createAigentError } from '../../core/aigent-error.js';
import { createMongoStore } from '../../store/mongo-store.js';
import type { MongoStore } from '../../store/mongo-store.js';
import type { MongoDbLike } from '../../store/mongo-types.js';

export interface ConnectMongoStoreOptions {
  /** Connection string, for example `mongodb://localhost:27017`. */
  uri: string;
  /** Database holding the store's collections. */
  dbName: string;
  /** Prefix of the collections the store owns. Default `aigent_`. */
  collectionPrefix?: string;
}

/** The slice of the `mongodb` module this file touches. */
interface MongoModule {
  MongoClient: new (uri: string) => {
    connect(): Promise<unknown>;
    close(): Promise<void>;
    db(name: string): MongoDbLike;
  };
}

const DRIVER_MODULE = 'mongodb';

async function loadDriver(): Promise<MongoModule> {
  try {
    // The name sits in a variable so the optional peer is neither bundled nor required to type-check.
    return await import(DRIVER_MODULE) as MongoModule;
  } catch (error) {
    throw createAigentError({
      code: 'invalid_definition',
      message: `The 'mongodb' package is not installed; run 'npm install mongodb' to use connectMongoStore (${error instanceof Error ? error.message : String(error)})`,
      details: { module: DRIVER_MODULE },
    });
  }
}

/** Connects with the `mongodb` driver (an optional peer dependency) and wraps the database as a store. `close()` closes the client. */
export async function connectMongoStore(options: ConnectMongoStoreOptions): Promise<MongoStore> {
  const { uri, dbName, collectionPrefix } = options;
  const { MongoClient } = await loadDriver();
  const client = new MongoClient(uri);
  await client.connect();
  return createMongoStore({ db: client.db(dbName), collectionPrefix, onClose: () => client.close() });
}
