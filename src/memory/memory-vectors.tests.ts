import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createWriteQueue } from '../store/write-queue.js';
import { createMemoryStore } from './memory-store.js';
import { MEMORY_COLLECTION } from './memory-types.js';
import type { MemoryEntry, ResolvedMemoryOptions } from './memory-types.js';
import { MEMORY_VECTOR_COLLECTION, dropMemoryVectors, readMemoryVector, writeMemoryVector } from './memory-vectors.js';
import type { MemoryVectorRecord } from './memory-vectors.js';
import { fixtureEntry } from './recall-fixtures.test-support.js';

const OPTIONS: ResolvedMemoryOptions = { scope: 'agent', maxEntries: 2, maxPerCall: 3, halfLifeDays: 30, minConfidence: 0.2, recallLimit: 6 };
const EMBEDDER = { embedderId: 'concept-v1', dimensions: 3 };

function vectorFor(entry: MemoryEntry): MemoryVectorRecord {
  return {
    memoryId: entry.id, agentName: entry.agentName, scopeKey: entry.scopeKey, recordedAt: entry.recordedAt, ...(entry.runId == null ? {} : { runId: entry.runId }),
    ...EMBEDDER, textHash: 'hash-of-text', vector: [1, 0, 0],
  };
}

async function put(store: Store, entry: MemoryEntry): Promise<void> {
  await store.compareAndSet({ collection: MEMORY_COLLECTION, key: entry.id, expectedVersion: undefined, value: entry });
  await writeMemoryVector({ store, record: vectorFor(entry) });
}

function withoutDelete(store: Store): Store {
  const { delete: _delete, ...rest } = store;
  return rest;
}

describe('memory vectors', () => {
  it('reads back a written vector, and nothing once it is dropped', async () => {
    const store = createInMemoryStore();
    const entry = fixtureEntry({ id: 'm1', text: 'deploy with the script' });
    await put(store, entry);
    expect(await readMemoryVector({ store, memoryId: 'm1' })).toEqual(vectorFor(entry));
    await dropMemoryVectors({ store, ids: ['m1', 'never-written'] });
    expect(await readMemoryVector({ store, memoryId: 'm1' })).toBeUndefined();
    expect(await store.list(MEMORY_VECTOR_COLLECTION)).toEqual([]);
  });

  it('keeps no vector on a store without delete: the record is emptied, still reachable by purge', async () => {
    const store = withoutDelete(createInMemoryStore());
    await put(store, fixtureEntry({ id: 'm1', text: 'deploy with the script', runId: 'run_7' }));
    await dropMemoryVectors({ store, ids: ['m1'] });
    expect(await readMemoryVector({ store, memoryId: 'm1' })).toBeUndefined();
    const [stored] = await store.list<Record<string, unknown>>(MEMORY_VECTOR_COLLECTION);
    expect(stored?.value).not.toHaveProperty('vector');
    expect(stored?.value).toMatchObject({ agentName: 'helper', runId: 'run_7', removed: true });
  });

  it('carries the entry\'s agent, run and time, so purge removes the vector with the entry', async () => {
    const store = createInMemoryStore();
    await put(store, fixtureEntry({ id: 'm1', text: 'one', runId: 'run_1' }));
    await put(store, fixtureEntry({ id: 'm2', text: 'two', runId: 'run_2' }));
    await store.purge?.({ runId: 'run_1' });
    expect((await store.list(MEMORY_VECTOR_COLLECTION)).map(({ key }) => key)).toEqual(['m2']);
    expect((await store.list(MEMORY_COLLECTION)).map(({ key }) => key)).toEqual(['m2']);
  });

  it('drops the vector of a forgotten memory, but keeps a user correction\'s', async () => {
    const store = createInMemoryStore();
    const memory = createMemoryStore({ store, writeQueue: createWriteQueue(), now: () => 2_000_000 });
    await put(store, fixtureEntry({ id: 'note', text: 'a note' }));
    await put(store, fixtureEntry({ id: 'lesson', text: 'a lesson', source: { runId: 'run_0', origin: 'user-correction' } }));
    const result = await memory.forget({ agentName: 'helper', scopeKey: 'agent', ids: ['note', 'lesson'] });
    expect(result).toMatchObject({ forgotten: ['note'], kept: ['lesson'] });
    expect(await readMemoryVector({ store, memoryId: 'note' })).toBeUndefined();
    expect(await readMemoryVector({ store, memoryId: 'lesson' })).toBeDefined();
  });

  it('never drops another scope\'s vector when forgetting an id that is not this scope\'s', async () => {
    const store = createInMemoryStore();
    const memory = createMemoryStore({ store, writeQueue: createWriteQueue(), now: () => 2_000_000 });
    await put(store, fixtureEntry({ id: 'theirs', text: 'their note', scopeKey: 'session:other' }));
    expect((await memory.forget({ agentName: 'helper', scopeKey: 'agent', ids: ['theirs'] })).notFound).toEqual(['theirs']);
    expect(await readMemoryVector({ store, memoryId: 'theirs' })).toBeDefined();
  });

  for (const [name, make] of [['with delete', createInMemoryStore], ['without delete', () => withoutDelete(createInMemoryStore())]] as const) {
    it(`drops the vectors of memories the cap evicts (${name})`, async () => {
      const store = make();
      const memory = createMemoryStore({ store, writeQueue: createWriteQueue(), now: () => 2_000_000 });
      await put(store, fixtureEntry({ id: 'old-1', text: 'old one', updatedAt: 1, recordedAt: 1 }));
      await put(store, fixtureEntry({ id: 'old-2', text: 'old two', updatedAt: 2, recordedAt: 2 }));
      const result = await memory.save({ options: OPTIONS, request: { agentName: 'helper', scopeKey: 'agent', source: { runId: 'run_9', origin: 'tool-call' }, notes: [{ kind: 'fact', text: 'brand new' }] } });
      expect(result.evicted).toBe(1);
      expect(await readMemoryVector({ store, memoryId: 'old-1' })).toBeUndefined();
      expect(await readMemoryVector({ store, memoryId: 'old-2' })).toBeDefined();
    });
  }
});
