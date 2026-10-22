// Live test against a real MongoDB. Skipped unless AIGENT_LIVE_MONGO holds a connection string (e.g.
// mongodb://localhost:27017) and the optional `mongodb` peer is installed, so the default suite never needs a database.
// It writes a scratch collection with the driver directly (the pack itself never writes) and drops it afterwards.
import { afterAll, describe, expect, it } from 'vitest';
import { createDbPolicy, validateQuery } from '../../../security/db-policy.js';
import { createMongoDbAccess } from './mongo-db-access.js';
import type { MongoCollectionLike, MongoDbLike } from './mongo-db-access.js';

const { AIGENT_LIVE_MONGO } = process.env;
const IS_LIVE = AIGENT_LIVE_MONGO != null && AIGENT_LIVE_MONGO !== '';
const DRIVER_PACKAGE = 'mongodb';
const DATABASE = 'aigent_live_tests';
const COLLECTION = `scratch_${process.pid}`;
const LIVE_TIMEOUT_MS = 30_000;

/** The driver surface the scratch setup uses (writes happen here only, never through the pack). */
interface LiveClient {
  connect(): Promise<unknown>;
  close(): Promise<void>;
  db(name: string): LiveDb;
}

/** Scratch-collection writes used by the setup only. */
interface ScratchWrites {
  insertMany(docs: unknown[]): Promise<unknown>;
  drop(): Promise<unknown>;
}

interface LiveDb extends MongoDbLike {
  collection(name: string): MongoCollectionLike & ScratchWrites;
}

interface LiveDriver {
  MongoClient: new (url: string) => LiveClient;
}

let client: LiveClient | undefined;

afterAll(async () => {
  await client?.db(DATABASE).collection(COLLECTION).drop().catch(() => undefined);
  await client?.close();
});

describe.skipIf(!IS_LIVE)('createMongoDbAccess against a real MongoDB (AIGENT_LIVE_MONGO)', () => {
  it('runs a validated find and count, with tagged results', async () => {
    const driver = (await import(DRIVER_PACKAGE)) as unknown as LiveDriver;
    client = new driver.MongoClient(AIGENT_LIVE_MONGO as string);
    await client.connect();
    const db = client.db(DATABASE);
    await db.collection(COLLECTION).insertMany([{ n: 1, when: new Date('2020-01-01T00:00:00Z'), secret: 'x' }, { n: 2, secret: 'y' }, { n: 3, secret: 'z' }]);
    const policy = createDbPolicy({ collections: { [COLLECTION]: { permissions: ['read'], denyFields: ['secret'] } } });
    const validated = validateQuery(policy, { collection: COLLECTION, filter: { n: { $gte: 2 } }, sort: [{ field: 'n', direction: 'asc' }], limit: 1 });
    if (!validated.ok) throw new Error(validated.message);
    const access = createMongoDbAccess({ db });
    const signal = new AbortController().signal;
    const result = await access.find({ ...validated.query, signal });
    expect(result.truncated).toBe(true);
    expect(result.docs).toEqual([{ _id: { $oid: expect.stringMatching(/^[0-9a-f]{24}$/) }, n: 2 }]);
    expect(await access.count({ collection: COLLECTION, filter: validated.query.filter, maxTimeMs: validated.query.maxTimeMs, signal })).toBe(2);
  }, LIVE_TIMEOUT_MS);
});
