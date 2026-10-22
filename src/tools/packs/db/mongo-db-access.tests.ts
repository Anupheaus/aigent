import { describe, expect, it } from 'vitest';
import { createMongoDbAccess } from './mongo-db-access.js';
import type { MongoCollectionLike, MongoCursorLike, MongoDbLike } from './mongo-db-access.js';

/** A BSON ObjectId as the driver gives it. */
function objectId(hex: string) {
  return { _bsontype: 'ObjectId', toHexString: () => hex, toString: () => hex };
}

interface FakeOptions {
  docs?: Record<string, unknown>[];
  /** The cursor's `next` never settles (a slow query). */
  hang?: boolean;
}

/** A `Db` double recording every method called on it; only `collection`, `find`, `countDocuments`, `next` and `close` exist. */
function fakeDb(options: FakeOptions = {}) {
  const { docs = [], hang = false } = options;
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string, args: unknown[]) => calls.push({ method, args });
  const cursor = (): MongoCursorLike => {
    let index = 0;
    return {
      next: async () => {
        record('next', []);
        if (hang) return new Promise(() => undefined);
        const doc = docs[index] ?? null;
        index += 1;
        return doc;
      },
      close: async () => {
        record('close', []);
      },
    };
  };
  const collection = (name: string): MongoCollectionLike => new Proxy({
    find: (filter: unknown, findOptions: unknown) => {
      record('find', [name, filter, findOptions]);
      return cursor();
    },
    countDocuments: async (filter: unknown, countOptions: unknown) => {
      record('countDocuments', [name, filter, countOptions]);
      return 42;
    },
  }, {
    // Any other method (aggregate, insertOne, deleteMany...) is recorded, so the test can prove it was never used.
    get: (target, property) => (property in target ? target[property as keyof typeof target] : (...args: unknown[]) => record(String(property), args)),
  });
  const db: MongoDbLike = { collection: name => collection(name) };
  return { db, calls };
}

const signal = new AbortController().signal;
const bson = { objectId: (hex: string) => ({ oid: hex }), decimal128: (text: string) => ({ decimal: text }) };

describe('createMongoDbAccess', () => {
  it('maps a validated query onto collection.find with maxTimeMS, a sort list, limit + 1 and the projection', async () => {
    const { db, calls } = fakeDb({ docs: [{ _id: objectId('5f1d7f1b2c3a4b5c6d7e8f90'), n: 1 }] });
    const access = createMongoDbAccess({ db, bson });
    const result = await access.find({ collection: 'users', filter: { n: { $gt: 0 } }, projection: { n: 1 }, sort: [{ field: 'n', direction: 'desc' }], limit: 5, skip: 2, maxTimeMs: 1_500, signal });
    expect(result).toEqual({ docs: [{ _id: { $oid: '5f1d7f1b2c3a4b5c6d7e8f90' }, n: 1 }], truncated: false });
    expect(calls[0]).toEqual({ method: 'find', args: ['users', { n: { $gt: 0 } }, { projection: { n: 1 }, sort: [['n', -1]], limit: 6, skip: 2, maxTimeMS: 1_500 }] });
    expect(calls.map(({ method }) => method)).toEqual(['find', 'next', 'next', 'close']);
  });

  it('reports more matches than the limit as truncated, reading only limit + 1 documents', async () => {
    const { db, calls } = fakeDb({ docs: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] });
    const result = await createMongoDbAccess({ db, bson }).find({ collection: 'c', filter: {}, limit: 2, maxTimeMs: 100, signal });
    expect(result).toEqual({ docs: [{ n: 1 }, { n: 2 }], truncated: true });
    expect(calls.filter(({ method }) => method === 'next')).toHaveLength(3);
    expect(calls.at(-1)?.method).toBe('close');
  });

  it('converts tagged literals in the filter to driver types, and BSON values in results to tagged JSON', async () => {
    const decimal = { _bsontype: 'Decimal128', toString: () => '1.50' };
    const { db, calls } = fakeDb({ docs: [{ when: new Date('2020-01-01T00:00:00Z'), price: decimal }] });
    const result = await createMongoDbAccess({ db, bson }).find({ collection: 'c', filter: { _id: { $oid: 'ab'.repeat(12) }, when: { $gt: { $date: '2019-01-01T00:00:00.000Z' } }, price: { $numberDecimal: '1.5' } }, limit: 1, maxTimeMs: 100, signal });
    const filter = (calls[0]?.args[1] ?? {}) as Record<string, Record<string, unknown>>;
    expect(filter._id).toEqual({ oid: 'ab'.repeat(12) });
    expect(filter.when?.$gt).toEqual(new Date('2019-01-01T00:00:00.000Z'));
    expect(filter.price).toEqual({ decimal: '1.5' });
    expect(result.docs).toEqual([{ when: { $date: '2020-01-01T00:00:00.000Z' }, price: { $numberDecimal: '1.50' } }]);
  });

  it('closes the cursor when the run is aborted mid-query', async () => {
    const { db, calls } = fakeDb({ hang: true });
    const controller = new AbortController();
    const pending = createMongoDbAccess({ db, bson }).find({ collection: 'c', filter: {}, limit: 5, maxTimeMs: 100, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(calls.at(-1)?.method).toBe('close');
  });

  it('counts with countDocuments and maxTimeMS, and never calls anything else', async () => {
    const { db, calls } = fakeDb();
    expect(await createMongoDbAccess({ db, bson }).count({ collection: 'c', filter: { a: 1 }, maxTimeMs: 250, signal })).toBe(42);
    expect(calls).toEqual([{ method: 'countDocuments', args: ['c', { a: 1 }, { maxTimeMS: 250 }] }]);
  });

  it('removes credentials from driver errors', async () => {
    const password = ['hunt', 'er2'].join('');
    const db: MongoDbLike = { collection: () => ({ find: () => { throw new Error(`connect failed for mongodb+srv://admin:${password}@cluster0.example.net/db`); }, countDocuments: async () => 0 }) };
    const failure = createMongoDbAccess({ db, bson }).find({ collection: 'c', filter: {}, limit: 1, maxTimeMs: 100, signal });
    await expect(failure).rejects.toThrow(/mongodb\+srv:\/\/\[REDACTED\]@cluster0/);
    await expect(failure).rejects.not.toThrow(new RegExp(password));
  });
});
