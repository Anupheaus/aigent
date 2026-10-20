import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from './in-memory-store.js';

describe('createInMemoryStore', () => {
  it('creates a record only when it does not exist yet', async () => {
    const store = createInMemoryStore();
    expect(await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: { n: 1 } })).toBe(true);
    expect(await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: { n: 2 } })).toBe(false);
    expect(await store.get('c', 'k')).toEqual({ key: 'k', value: { n: 1 }, version: 1 });
  });

  it('updates only with the matching version and bumps it', async () => {
    const store = createInMemoryStore();
    await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 'a' });
    expect(await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: 5, value: 'b' })).toBe(false);
    expect(await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: 1, value: 'b' })).toBe(true);
    expect(await store.get('c', 'k')).toMatchObject({ value: 'b', version: 2 });
  });

  it('returns copies so callers cannot mutate stored state', async () => {
    const store = createInMemoryStore();
    await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: { list: [1] } });
    const first = await store.get<{ list: number[] }>('c', 'k');
    first!.value.list.push(2);
    expect((await store.get<{ list: number[] }>('c', 'k'))!.value.list).toEqual([1]);
  });

  it('lists a collection and returns undefined for missing keys', async () => {
    const store = createInMemoryStore();
    expect(await store.get('c', 'missing')).toBeUndefined();
    await store.compareAndSet({ collection: 'c', key: 'a', expectedVersion: undefined, value: 1 });
    await store.compareAndSet({ collection: 'c', key: 'b', expectedVersion: undefined, value: 2 });
    expect((await store.list('c')).map(record => record.key).sort()).toEqual(['a', 'b']);
    expect(await store.list('other')).toEqual([]);
  });
});

describe('createInMemoryStore purge', () => {
  async function seeded() {
    const store = createInMemoryStore();
    const records = [
      ['runs', 'r1', { agentName: 'a', runId: 'r1', recordedAt: 100 }],
      ['traces', 'r1', { agentName: 'a', runId: 'r1', recordedAt: 100 }],
      ['runs', 'r2', { agentName: 'a', runId: 'r2', recordedAt: 300 }],
      ['runs', 'r3', { agentName: 'b', runId: 'r3', recordedAt: 100 }],
      ['other', 'plain', 'not an object'],
    ] as const;
    for (const [collection, key, value] of records) await store.compareAndSet({ collection, key, expectedVersion: undefined, value });
    return store;
  }

  async function keys(store: ReturnType<typeof createInMemoryStore>): Promise<string[]> {
    const listed = await Promise.all(['runs', 'traces', 'other'].map(async collection => (await store.list(collection)).map(record => `${collection}/${record.key}`)));
    return listed.flat().sort();
  }

  it('deletes records of one run across collections and returns the count', async () => {
    const store = await seeded();
    expect(await store.purge?.({ runId: 'r1' })).toBe(2);
    expect(await keys(store)).toEqual(['other/plain', 'runs/r2', 'runs/r3']);
  });

  it('combines criteria: records of one agent written before a time', async () => {
    const store = await seeded();
    expect(await store.purge?.({ agentName: 'a', before: 200 })).toBe(2);
    expect(await keys(store)).toEqual(['other/plain', 'runs/r2', 'runs/r3']);
  });

  it('purges every record of an agent and never touches records without the fields', async () => {
    const store = await seeded();
    expect(await store.purge?.({ agentName: 'b' })).toBe(1);
    expect(await store.purge?.({ before: 1_000 })).toBe(3);
    expect(await keys(store)).toEqual(['other/plain']);
  });
});
