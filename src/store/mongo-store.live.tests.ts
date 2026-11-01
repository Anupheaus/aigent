// Live test against a real MongoDB. Skipped unless AIGENT_LIVE_MONGO holds a connection string (e.g.
// mongodb://localhost:27017) and the optional `mongodb` peer is installed, so the default suite never needs a database.
// Every test gets collections under its own prefix in database `aigent_live_tests`, dropped afterwards.
import { describe } from 'vitest';
import { describeStoreContract } from '../testing/contract/store-contract.js';
import { createMongoStore } from './mongo-store.js';
import type { MongoDbLike } from './mongo-types.js';

const { AIGENT_LIVE_MONGO } = process.env;
const IS_LIVE = AIGENT_LIVE_MONGO != null && AIGENT_LIVE_MONGO !== '';
const DRIVER_PACKAGE = 'mongodb';
const DATABASE = 'aigent_live_tests';
/** Fewer than the contract's defaults: every write is a round trip to the server. */
const LIVE_WRITERS = 20;
const LIVE_ROUNDS = 3;

/** The driver surface the test uses beyond the store's own: connecting and dropping scratch collections. */
interface LiveDb extends MongoDbLike {
  dropCollection(name: string): Promise<unknown>;
}

interface LiveClient {
  connect(): Promise<unknown>;
  close(): Promise<void>;
  db(name: string): LiveDb;
}

interface LiveDriver {
  MongoClient: new (url: string) => LiveClient;
}

let created = 0;

describe.skipIf(!IS_LIVE)('mongo store against a real MongoDB (AIGENT_LIVE_MONGO)', () => {
  describeStoreContract({
    name: 'mongo store (live)',
    contentionWriters: LIVE_WRITERS,
    contentionRounds: LIVE_ROUNDS,
    create: async () => {
      const driver = (await import(DRIVER_PACKAGE)) as unknown as LiveDriver;
      const client = new driver.MongoClient(AIGENT_LIVE_MONGO as string);
      await client.connect();
      const db = client.db(DATABASE);
      created += 1;
      const collectionPrefix = `live_${process.pid}_${created}_`;
      const store = createMongoStore({ db, collectionPrefix, onClose: () => client.close() });
      return {
        store,
        cleanup: async () => {
          const names = await db.listCollections({}).toArray();
          for (const { name } of names) if (name.startsWith(collectionPrefix)) await db.dropCollection(name);
          await store.close();
        },
      };
    },
  });
});
