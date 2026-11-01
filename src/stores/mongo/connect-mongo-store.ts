import { createAigentError } from '../../core/aigent-error.js';
import type { MongoStore } from '../../store/mongo-store.js';
import { openMongoStore } from './open-mongo-store.js';
import type { ConnectMongoStoreOptions, MongoDriver } from './open-mongo-store.js';

export type { ConnectMongoStoreOptions } from './open-mongo-store.js';

const DRIVER_MODULE = 'mongodb';

async function loadDriver(): Promise<MongoDriver> {
  try {
    // The name sits in a variable so the optional peer is neither bundled nor required to type-check.
    return await import(DRIVER_MODULE) as MongoDriver;
  } catch (error) {
    throw createAigentError({
      code: 'invalid_definition',
      message: `The 'mongodb' package is not installed; run 'npm install mongodb' to use connectMongoStore (${error instanceof Error ? error.message : String(error)})`,
      details: { module: DRIVER_MODULE },
    });
  }
}

/**
 * Connects with the `mongodb` driver (an optional peer dependency) and wraps the database as a store. `close()`
 * closes the client; a failed connect closes it at once and throws `store_failed`.
 */
export async function connectMongoStore(options: ConnectMongoStoreOptions): Promise<MongoStore> {
  return openMongoStore({ options, driver: await loadDriver() });
}
