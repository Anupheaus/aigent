import { describe, expect, it } from 'vitest';
import { isAigentError } from '../core/aigent-error.js';
import { describeStoreContract } from '../testing/contract/store-contract.js';
import { createMongoFake } from './mongo-fake.test-support.js';
import { createMongoStore } from './mongo-store.js';

const ALLOWED_OPERATIONS = ['findOne', 'find', 'insertOne', 'updateOne', 'deleteOne', 'deleteMany', 'createIndex', 'listCollections'];

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
    await Promise.all([store.get('c', 'a'), store.get('c', 'b'), store.list('c')]);
    await store.get('c', 'again');
    expect(fake.calls.filter(call => call.operation === 'createIndex')).toHaveLength(1);
    expect([...fake.indexes.keys()]).toEqual(['mine_c']);
    fake.db.collection('foreign');
    await fake.db.collection('foreign').insertOne({ _id: 'x', version: 1, value: { agentName: 'a' } });
    expect(await store.purge({ agentName: 'a' })).toBe(0);
  });

  it('retries index creation after a failure instead of caching it', async () => {
    const fake = createMongoFake();
    const store = createMongoStore({ db: fake.db });
    fake.failNext('createIndex', new Error('transient'));
    await expect(store.get('c', 'k')).rejects.toThrow('transient');
    expect(await store.get('c', 'k')).toBeUndefined();
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
