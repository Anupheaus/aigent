import { describe, expect, it } from 'vitest';
import { createMongoFake } from './mongo-fake.test-support.js';
import type { MongoFilter } from './mongo-types.js';

/** The fake's collection with any document shape: these tests write what the store never would. */
interface LooseCollection {
  findOne(filter: MongoFilter): Promise<unknown>;
  insertOne(document: Record<string, unknown>): Promise<unknown>;
  updateOne(filter: MongoFilter, update: { $set: Record<string, unknown> }): Promise<unknown>;
  deleteMany(filter: MongoFilter): Promise<unknown>;
}

function looseCollection(name: string, fake = createMongoFake()): LooseCollection {
  return fake.db.collection(name) as unknown as LooseCollection;
}

/** Over MongoDB's 16 MiB document limit. */
const OVERSIZED_BYTES = 17_000_000;

async function failureOf(action: Promise<unknown>): Promise<unknown> {
  return action.then(() => undefined, (error: unknown) => error);
}

describe('mongo fake', () => {
  it('rejects a $-prefixed field name inside a $set value, as the server does', async () => {
    const collection = looseCollection('c');
    await collection.insertOne({ _id: 'k', version: 1, value: 1 });
    const failure = await failureOf(collection.updateOne({ _id: 'k', version: 1 }, { $set: { version: 2, value: { nested: { $schema: 'x' } } } }));
    expect((failure as Error).message).toContain('$schema');
    expect(await collection.findOne({ _id: 'k' })).toEqual({ _id: 'k', version: 1, value: 1 });
  });

  it('rejects documents over 16 MiB on insert and update', async () => {
    const collection = looseCollection('c');
    const big = 'x'.repeat(OVERSIZED_BYTES);
    expect((await failureOf(collection.insertOne({ _id: 'big', version: 1, value: big })) as { code?: unknown }).code).toBe(10_334);
    await collection.insertOne({ _id: 'k', version: 1, value: 1 });
    expect((await failureOf(collection.updateOne({ _id: 'k', version: 1 }, { $set: { version: 2, value: big } })) as { code?: unknown }).code).toBe(10_334);
  });

  it('lists views as views, and refuses to delete from one', async () => {
    const fake = createMongoFake();
    fake.createView('a_view');
    expect(await fake.db.listCollections({ type: 'collection' }).toArray()).toEqual([]);
    expect(await failureOf(looseCollection('a_view', fake).deleteMany({}))).toBeInstanceOf(Error);
  });

  it('matches a field through an array, as the server does', async () => {
    const collection = looseCollection('c');
    await collection.insertOne({ _id: 'k', version: 1, value: [{ agentName: 'a' }] });
    expect(await collection.findOne({ 'value.agentName': 'a' })).not.toBeNull();
  });
});

describe('mongo fake filters used by list', () => {
  it('matches null against a missing field, as the server does, and supports $or and $exists', async () => {
    const fake = createMongoFake();
    const collection = looseCollection('c', fake);
    await collection.insertOne({ _id: 'withNull', fields: { a: null } });
    await collection.insertOne({ _id: 'missing', fields: {} });
    await collection.insertOne({ _id: 'set', fields: { a: 1 } });
    await collection.insertOne({ _id: 'legacy' });
    const ids = async (filter: MongoFilter): Promise<string[]> => (await fake.db.collection('c').find(filter).toArray()).map(({ _id }) => _id).sort();
    expect(await ids({ 'fields.a': null })).toEqual(['legacy', 'missing', 'withNull']);
    expect(await ids({ fields: { $exists: false } })).toEqual(['legacy']);
    expect(await ids({ fields: { $exists: true } })).toEqual(['missing', 'set', 'withNull']);
    expect(await ids({ $or: [{ 'fields.a': 1 }, { fields: { $exists: false } }] })).toEqual(['legacy', 'set']);
  });

  it('records the filter of every find', async () => {
    const fake = createMongoFake();
    await fake.db.collection('c').find({ 'fields.a': 1 }).toArray();
    expect(fake.finds).toEqual([{ 'fields.a': 1 }]);
  });
});
