import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { purgeRecords } from './purge-records.js';

describe('purgeRecords', () => {
  it('passes a valid filter to the store and resolves with its count', async () => {
    const store = createInMemoryStore();
    await store.compareAndSet({ collection: 'runs', key: 'r1', expectedVersion: undefined, value: { agentName: 'a', runId: 'r1', recordedAt: 1 } });
    expect(await purgeRecords({ store, filter: { runId: 'r1' } })).toBe(1);
  });

  it.each([
    [{}, 'at least one'],
    [{ agentName: '' }, 'agentName'],
    [{ before: Number.NaN }, 'before'],
    [{ tenant: 'x' }, 'tenant'],
  ])('rejects the filter %j with invalid_input', async (filter, mentioned) => {
    await expect(purgeRecords({ store: createInMemoryStore(), filter })).rejects.toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining(mentioned) }));
  });
});
