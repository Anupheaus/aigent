import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from './in-memory-store.js';
import { updateRecord } from './update-record.js';

// Every in-process updater racing on one key must succeed with the default settings.
const CONCURRENT_UPDATERS = 25;

describe('updateRecord', () => {
  it('creates then updates, with concurrent updaters never losing increments (default maxAttempts)', async () => {
    const store = createInMemoryStore();
    const bump = () => updateRecord<number>({ store, collection: 'c', key: 'counter', update: current => (current ?? 0) + 1 });
    await Promise.all(Array.from({ length: CONCURRENT_UPDATERS }, bump));
    expect((await store.get<number>('c', 'counter'))?.value).toBe(CONCURRENT_UPDATERS);
  });

  it('fails with store_conflict after maxAttempts', async () => {
    const store = createInMemoryStore();
    const conflicting = { ...store, compareAndSet: async () => false };
    await expect(updateRecord<number>({ store: conflicting, collection: 'c', key: 'k', update: () => 1, maxAttempts: 3, sleep: async () => undefined })).rejects.toMatchObject({ code: 'store_conflict' });
  });

  it('waits a jittered, growing, capped backoff between attempts but not after the last', async () => {
    const store = createInMemoryStore();
    const conflicting = { ...store, compareAndSet: async () => false };
    const delays: number[] = [];
    const sleep = async (delayMs: number): Promise<void> => { delays.push(delayMs); };
    await expect(updateRecord<number>({ store: conflicting, collection: 'c', key: 'k', update: () => 1, maxAttempts: 12, sleep })).rejects.toMatchObject({ code: 'store_conflict' });
    expect(delays).toHaveLength(11);
    for (const delayMs of delays) {
      expect(delayMs).toBeGreaterThanOrEqual(0);
      expect(delayMs).toBeLessThanOrEqual(50);
    }
    // Jitter: the delays are not all identical.
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it('does not sleep when the first attempt succeeds', async () => {
    const store = createInMemoryStore();
    let sleeps = 0;
    await updateRecord<number>({ store, collection: 'c', key: 'k', update: () => 1, sleep: async () => { sleeps += 1; } });
    expect(sleeps).toBe(0);
  });
});
