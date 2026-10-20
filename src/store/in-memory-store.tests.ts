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
