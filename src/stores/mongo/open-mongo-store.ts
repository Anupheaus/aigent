import { createAigentError } from '../../core/aigent-error.js';
import { createMongoStore } from '../../store/mongo-store.js';
import type { MongoStore } from '../../store/mongo-store.js';
import type { MongoDbLike } from '../../store/mongo-types.js';

/** `connectMongoStore(options)`. */
export interface ConnectMongoStoreOptions {
  /** Connection string, for example `mongodb://localhost:27017`. */
  uri: string;
  /** Database holding the store's collections. */
  dbName: string;
  /** Prefix of the collections the store owns. Default `aigent_`. */
  collectionPrefix?: string;
}

/** The slice of the `mongodb` module the store is opened with. */
export interface MongoDriver {
  MongoClient: new (uri: string) => {
    connect(): Promise<unknown>;
    close(): Promise<void>;
    db(name: string): MongoDbLike;
  };
}

/** Removes the credentials a connection string may carry (`user:password@`) before it appears in an error. */
function withoutCredentials(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, '//***@');
}

/** Connects a client from `driver` and wraps the database as a store; a failed connect closes the client and throws `store_failed`. */
export async function openMongoStore(params: { options: ConnectMongoStoreOptions; driver: MongoDriver }): Promise<MongoStore> {
  const { options: { uri, dbName, collectionPrefix }, driver: { MongoClient } } = params;
  const client = new MongoClient(uri);
  try {
    await client.connect();
  } catch (error) {
    // A failed connect may have opened sockets or monitors; closing releases them so the process can exit.
    await client.close().catch(() => undefined);
    throw createAigentError({
      code: 'store_failed',
      message: `Could not connect to MongoDB at '${withoutCredentials(uri)}': ${error instanceof Error ? error.message : String(error)}`,
      details: { dbName, retryable: true },
    });
  }
  return createMongoStore({ db: client.db(dbName), ...(collectionPrefix == null ? {} : { collectionPrefix }), onClose: () => client.close() });
}
