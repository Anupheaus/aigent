import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from './in-memory-store.js';
import { updateRecord } from './update-record.js';

// Worst case every updater loses to all the others once, so attempts must cover the contender count.
const CONCURRENT_UPDATERS = 25;

describe('updateRecord', () => {
  it('creates then updates, with concurrent updaters never losing increments', async () => {
    const store = createInMemoryStore();
    const bump = () => updateRecord<number>({ store, collection: 'c', key: 'counter', update: current => (current ?? 0) + 1, maxAttempts: CONCURRENT_UPDATERS });
    await Promise.all(Array.from({ length: CONCURRENT_UPDATERS }, bump));
    expect((await store.get<number>('c', 'counter'))?.value).toBe(CONCURRENT_UPDATERS);
  });

  it('fails with store_conflict after maxAttempts', async () => {
    const store = createInMemoryStore();
    const conflicting = { ...store, compareAndSet: async () => false };
    await expect(updateRecord<number>({ store: conflicting, collection: 'c', key: 'k', update: () => 1, maxAttempts: 3 })).rejects.toMatchObject({ code: 'store_conflict' });
  });
});
