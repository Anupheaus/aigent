import { describe, expect, it } from 'vitest';
import { isAigentError } from '../core/aigent-error.js';
import { describeStoreContract } from '../testing/contract/store-contract.js';
import { createMongoFake } from './mongo-fake.test-support.js';
import { createMongoStore } from './mongo-store.js';

/** Over MongoDB's 16 MiB document limit. */
const OVERSIZED_BYTES = 17_000_000;
const WRITE_CONFLICT_CODE = 112;
/** Longer than the store copies into `fields`. */
const LONG_STRING = 300;
const ALLOWED_OPERATIONS =['findOne', 'find', 'insertOne', 'updateOne', 'deleteOne', 'deleteMany', 'createIndex', 'listCollections'];

describeStoreContract({
  name: 'mongo store (fake driver)',
  create: async () => ({ store: createMongoStore({ db: createMongoFake().db }) }),
});

async function failureOf(action: Promise<unknown>): Promise<unknown> {
  return action.then(() => undefined, (error: unknown) => error);
}

describe('mongo store', () => {
  it('maps a duplicate-key race to a failed compare-and-set, not an exception', async () => {
    const fake = createMongoFake();
    const store = createMongoStore({ db: fake.db });
    const outcomes = await Promise.all([1, 2, 3, 4, 5].map(value => store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value })));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it('wraps driver failures as store_failed, saying whether a retry may help', async () => {
    const fake = createMongoFake();
    const store = createMongoStore({ db: fake.db });
    fake.failNext('findOne', Object.assign(new Error('connection reset'), { name: 'MongoNetworkError' }));
    const transient = await failureOf(store.get('c', 'k'));
    expect(isAigentError(transient) && transient.code).toBe('store_failed');
    expect((transient as { details?: Record<string, unknown> }).details).toMatchObject({ collection: 'c', key: 'k', retryable: true });
    fake.failNext('insertOne', new Error('not authorised'));
    const permanent = await failureOf(store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 1 }));
    expect((permanent as { details?: Record<string, unknown> }).details).toMatchObject({ retryable: false });
    expect((permanent as Error).message).toContain('not authorised');
  });

  it('uses only the documented driver operations', async () => {
    const fake = createMongoFake();
    const store = createMongoStore({ db: fake.db });
    await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: { agentName: 'a', recordedAt: 1 } });
    await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: 1, value: { agentName: 'a', recordedAt: 2 } });
    await store.get('c', 'k');
    await store.list('c');
    await store.delete('c', 'k');
    await store.purge({ agentName: 'a' });
    expect([...new Set(fake.calls.map(call => call.operation))].every(operation => ALLOWED_OPERATIONS.includes(operation))).toBe(true);
  });

  it('creates each collection index once, even for concurrent first use, and keeps to its own prefix', async () => {
    const fake = createMongoFake();
    const store = createMongoStore({ db: fake.db, collectionPrefix: 'mine_' });
    // Only writes create a collection (and its index): a read of a missing collection changes nothing on the server.
    const create = (key: string): Promise<boolean> => store.compareAndSet({ collection: 'c', key, expectedVersion: undefined, value: key });
    await Promise.all([create('a'), create('b'), create('c')]);
    await create('again');
    expect(fake.calls.filter(call => call.operation === 'createIndex')).toHaveLength(1);
    expect([...fake.indexes.keys()]).toEqual(['mine_c']);
    fake.db.collection('foreign');
    await fake.db.collection('foreign').insertOne({ _id: 'x', version: 1, json: '{"agentName":"a"}', store: 'foreign_', purge: { agentName: 'a' } });
    expect(await store.purge({ agentName: 'a' })).toBe(0);
  });

  it('retries index creation after a failure instead of caching it', async () => {
    const fake = createMongoFake();
    const store = createMongoStore({ db: fake.db });
    fake.failNext('createIndex', new Error('transient'));
    await expect(store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 1 })).rejects.toThrow('transient');
    expect(await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 1 })).toBe(true);
  });

  it('stores values whose field names start with $ or hold a dot, and updates them', async () => {
    const store = createMongoStore({ db: createMongoFake().db });
    const value = { $schema: 'https://json-schema.org/draft/2020-12/schema', 'a.b': { $ref: '#/x' }, list: [{ $id: 1 }] };
    expect(await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value })).toBe(true);
    expect(await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: 1, value: { ...value, more: true } })).toBe(true);
    expect(await store.get('c', 'k')).toEqual({ key: 'k', value: { ...value, more: true }, version: 2 });
  });

  it('refuses a value too big for one MongoDB document with invalid_input, naming the limit, before sending it', async () => {
    const fake = createMongoFake();
    const store = createMongoStore({ db: fake.db });
    const failure = await failureOf(store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 'x'.repeat(OVERSIZED_BYTES) }));
    expect(isAigentError(failure) && failure.code).toBe('invalid_input');
    expect((failure as Error).message).toContain('16 MiB');
    expect(fake.calls.filter(call => call.operation === 'insertOne')).toEqual([]);
  });

  it('reads and lists without creating collections', async () => {
    const fake = createMongoFake();
    const store = createMongoStore({ db: fake.db });
    await store.get('c', 'k');
    await store.list('c');
    expect(await fake.db.listCollections({}).toArray()).toEqual([]);
  });

  it('purges only its own records, never those of a store whose prefix starts with its own, and skips views', async () => {
    const fake = createMongoFake();
    const mine = createMongoStore({ db: fake.db, collectionPrefix: 'aigent_' });
    const longer = createMongoStore({ db: fake.db, collectionPrefix: 'aigent_x_' });
    await longer.compareAndSet({ collection: 'runs', key: 'r', expectedVersion: undefined, value: { agentName: 'a' } });
    // Both stores name this collection 'aigent_x_runs'; only the `store` field tells their records apart.
    await mine.compareAndSet({ collection: 'x_runs', key: 'mine', expectedVersion: undefined, value: { agentName: 'a' } });
    fake.createView('aigent_view');
    expect(await mine.purge({ agentName: 'a' })).toBe(1);
    expect(await longer.get('runs', 'r')).toMatchObject({ value: { agentName: 'a' } });
  });

  it('purges by the same rule as the other stores: never through an array value', async () => {
    const store = createMongoStore({ db: createMongoFake().db });
    await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: [{ agentName: 'a' }] });
    expect(await store.purge({ agentName: 'a' })).toBe(0);
  });

  it('treats a write conflict as a lost compare-and-set', async () => {
    const fake = createMongoFake();
    const store = createMongoStore({ db: fake.db });
    await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 1 });
    fake.failNext('updateOne', Object.assign(new Error('WriteConflict error: this operation conflicted with another operation'), { code: WRITE_CONFLICT_CODE }));
    expect(await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: 1, value: 2 })).toBe(false);
  });

  it('closes the connection once and refuses work afterwards', async () => {
    let closes = 0;
    const store = createMongoStore({ db: createMongoFake().db, onClose: async () => { closes += 1; } });
    await store.close();
    await store.close();
    expect(closes).toBe(1);
    const failure = await failureOf(store.get('c', 'k'));
    expect(isAigentError(failure) && failure.code).toBe('store_failed');
    expect((failure as Error).message).toContain('closed');
  });
});

describe('mongo store list filters', () => {
  it('copies short top-level scalars into fields, leaving out long strings, objects and names MongoDB would misread', async () => {
    const fake = createMongoFake();
    const store = createMongoStore({ db: fake.db });
    const value = { agentName: 'a', n: 1, ok: false, gone: null, text: 'x'.repeat(LONG_STRING), nested: { b: 1 }, list: [1], 'a.b': 1, $kind: 'x' };
    await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value });
    const [document] = await fake.db.collection('aigent_c').find({}).toArray();
    expect((document as unknown as { fields: unknown }).fields).toEqual({ agentName: 'a', n: 1, ok: false, gone: null });
    await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: 1, value: { agentName: 'b' } });
    const [updated] = await fake.db.collection('aigent_c').find({}).toArray();
    expect((updated as unknown as { fields: unknown }).fields).toEqual({ agentName: 'b' });
    await store.compareAndSet({ collection: 'c', key: 'scalar', expectedVersion: undefined, value: 'text' });
    expect((await fake.db.collection('aigent_c').findOne({ _id: 'scalar' }) as unknown as { fields: unknown }).fields).toBeNull();
  });

  it('sends where to the server as a filter on fields, keeping documents written before fields existed', async () => {
    const fake = createMongoFake();
    const store = createMongoStore({ db: fake.db });
    await store.compareAndSet({ collection: 'c', key: 'mine', expectedVersion: undefined, value: { agentName: 'a', scopeKey: 's' } });
    await store.compareAndSet({ collection: 'c', key: 'other', expectedVersion: undefined, value: { agentName: 'b', scopeKey: 's' } });
    // A document from an earlier version of the store: no fields.
    await fake.db.collection('aigent_c').insertOne({ _id: 'legacy', version: 1, json: '{"agentName":"a","scopeKey":"s"}', store: 'aigent_', purge: { agentName: 'a' } });
    await fake.db.collection('aigent_c').insertOne({ _id: 'legacyOther', version: 1, json: '{"agentName":"b","scopeKey":"s"}', store: 'aigent_', purge: { agentName: 'b' } });
    const before = fake.finds.length;
    const listed = await store.list('c', { where: { agentName: 'a', scopeKey: 's' } });
    expect(listed.map(({ key }) => key).sort()).toEqual(['legacy', 'mine']);
    expect(fake.finds.slice(before)).toEqual([{ $or: [{ 'fields.agentName': 'a', 'fields.scopeKey': 's' }, { fields: { $exists: false } }] }]);
  });

  it('filters on the client when a where value or name cannot be matched on the server', async () => {
    const fake = createMongoFake();
    const store = createMongoStore({ db: fake.db });
    const long = 'x'.repeat(LONG_STRING);
    await store.compareAndSet({ collection: 'c', key: 'long', expectedVersion: undefined, value: { text: long } });
    await store.compareAndSet({ collection: 'c', key: 'other', expectedVersion: undefined, value: { text: 'short' } });
    const before = fake.finds.length;
    expect((await store.list('c', { where: { text: long } })).map(({ key }) => key)).toEqual(['long']);
    expect((await store.list('c', { where: { 'a.b': 1 } }))).toEqual([]);
    expect(fake.finds.slice(before)).toEqual([{}, {}]);
  });
});
