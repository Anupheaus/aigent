import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createWriteQueue } from '../store/write-queue.js';
import { createMemoryStore } from './memory-store.js';
import { MEMORY_COLLECTION } from './memory-types.js';
import type { MemoryEntry, ResolvedMemoryOptions } from './memory-types.js';

const OPTIONS: ResolvedMemoryOptions = { scope: 'agent', maxEntries: 5, maxPerCall: 3, halfLifeDays: 30, minConfidence: 0.2, recallLimit: 6 };
const PARALLEL_SAVES = 50;
const DISTINCT_NOTES = 20;

/** Yields to the event loop around every read and write, so unqueued read-modify-writes would interleave and lose updates. */
function slowStore(): Store {
  const base = createInMemoryStore();
  const pause = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  return {
    get: async (collection, key) => { await pause(); return base.get(collection, key); },
    compareAndSet: async params => { await pause(); return base.compareAndSet(params); },
    list: async collection => { await pause(); return base.list(collection); },
    delete: async (collection, key) => { await pause(); await base.delete?.(collection, key); },
  };
}

describe('createMemoryStore', () => {
  it('turns 50 overlapping parallel saves into exactly the deduplicated set, within the cap', async () => {
    const store = slowStore();
    const memory = createMemoryStore({ store, writeQueue: createWriteQueue(), now: () => 1_000 });
    const saves = Array.from({ length: PARALLEL_SAVES }, (_unused, run) => memory.save({
      options: { ...OPTIONS, maxEntries: 200 },
      request: { agentName: 'helper', scopeKey: 'agent', source: { runId: `run_${run}`, origin: 'tool-call' }, notes: [{ kind: 'fact', text: `note ${run % DISTINCT_NOTES}` }] },
    }));
    const results = await Promise.all(saves);
    expect(results.every(({ saved, problems }) => saved === 1 && problems.length === 0)).toBe(true);
    const entries = (await store.list<MemoryEntry>(MEMORY_COLLECTION)).map(({ value }) => value);
    expect(entries.map(({ text }) => text).sort()).toEqual(Array.from({ length: DISTINCT_NOTES }, (_unused, note) => `note ${note}`).sort());
    // Notes 0-9 are sent by three runs (0.6, 0.7, 0.8) and notes 10-19 by two: a lost update would show a lower confidence.
    for (const { text, confidence } of entries) expect(confidence).toBe(Number(text.split(' ')[1]) < 10 ? 0.8 : 0.7);
    const capped = createMemoryStore({ store, writeQueue: createWriteQueue(), now: () => 2_000 });
    await Promise.all(Array.from({ length: PARALLEL_SAVES }, (_unused, run) => capped.save({
      options: OPTIONS, request: { agentName: 'helper', scopeKey: 'session:s', source: { runId: `r${run}`, origin: 'tool-call' }, notes: [{ kind: 'fact', text: `capped ${run}` }] },
    })));
    const inScope = (await store.list<MemoryEntry>(MEMORY_COLLECTION)).filter(({ value }) => value.scopeKey === 'session:s');
    expect(inScope).toHaveLength(OPTIONS.maxEntries);
  });

  it('runs one agent\'s saves in arrival order and other agents\' alongside', async () => {
    const order: string[] = [];
    const base = slowStore();
    const store: Store = { ...base, compareAndSet: async params => { order.push(`${(params.value as MemoryEntry).agentName}:${(params.value as MemoryEntry).text}`); return base.compareAndSet(params); } };
    const memory = createMemoryStore({ store, writeQueue: createWriteQueue(), now: () => 1_000 });
    const saveNote = (agentName: string, text: string) => memory.save({ options: OPTIONS, request: { agentName, scopeKey: 'agent', source: { runId: 'r', origin: 'tool-call' }, notes: [{ kind: 'fact', text }] } });
    await Promise.all([saveNote('a', 'first'), saveNote('b', 'first'), saveNote('a', 'second'), saveNote('a', 'third')]);
    expect(order.filter(step => step.startsWith('a:'))).toEqual(['a:first', 'a:second', 'a:third']);
    expect(order).toContain('b:first');
  });

  const RECALLS = 20;
  const note = (text: string, scopeKey = 'agent') => ({ options: OPTIONS, request: { agentName: 'helper', scopeKey, source: { runId: 'r', origin: 'tool-call' as const }, notes: [{ kind: 'fact' as const, text }] } });

  it(`counts every one of ${RECALLS} concurrent recalls as a use, with the time of the use`, async () => {
    const store = slowStore();
    let clock = 1_000;
    const memory = createMemoryStore({ store, writeQueue: createWriteQueue(), now: () => clock });
    await memory.save(note('lint before committing'));
    clock = 2_000;
    const recalls = await Promise.all(Array.from({ length: RECALLS }, () => memory.recall({ agentName: 'helper', scopeKey: 'agent', query: 'lint', limit: 5 })));
    await Promise.all(recalls.map(({ used }) => used));
    const [entry] = (await store.list<MemoryEntry>(MEMORY_COLLECTION)).map(({ value }) => value);
    expect(entry).toMatchObject({ uses: RECALLS, lastUsedAt: 2_000 });
  });

  it('does not count a use when asked not to', async () => {
    const store = createInMemoryStore();
    const memory = createMemoryStore({ store, writeQueue: createWriteQueue(), now: () => 1_000 });
    await memory.save(note('lint before committing'));
    const { memories, used } = await memory.recall({ agentName: 'helper', scopeKey: 'agent', query: 'lint', limit: 5, markUsed: false });
    await used;
    expect(memories).toHaveLength(1);
    expect((await store.list<MemoryEntry>(MEMORY_COLLECTION))[0]?.value.uses).toBe(0);
  });

  it('never forgets a user correction\'s lesson for the model, and recall says where each memory came from', async () => {
    const store = createInMemoryStore();
    const memory = createMemoryStore({ store, writeQueue: createWriteQueue(), now: () => 1_000 });
    await memory.save({ options: OPTIONS, request: { agentName: 'helper', scopeKey: 'agent', source: { runId: 'r', origin: 'user-correction' }, notes: [{ kind: 'lesson', text: 'lint with the strict config' }] } });
    await memory.save(note('lint before committing'));
    const recalled = (await memory.recall({ agentName: 'helper', scopeKey: 'agent', query: 'lint', limit: 5 })).memories;
    const lesson = recalled.find(({ origin }) => origin === 'user-correction')?.id ?? '';
    expect(recalled.map(({ origin }) => origin).sort()).toEqual(['tool-call', 'user-correction']);
    expect(await memory.forget({ agentName: 'helper', scopeKey: 'agent', ids: [lesson] })).toEqual({ forgotten: [], notFound: [], kept: [lesson] });
    expect((await memory.recall({ agentName: 'helper', scopeKey: 'agent', query: 'lint', limit: 5 })).memories.map(({ id }) => id)).toContain(lesson);
  });

  it('forgets live entries of its own agent and scope only, never recalls them, and a later save brings one back', async () => {
    const store = createInMemoryStore();
    const memory = createMemoryStore({ store, writeQueue: createWriteQueue(), now: () => 1_000 });
    await memory.save(note('lint before committing'));
    await memory.save(note('lint in session', 'session:s1'));
    const entries = (await store.list<MemoryEntry>(MEMORY_COLLECTION)).map(({ value }) => value);
    const mine = entries.find(({ scopeKey }) => scopeKey === 'agent')?.id ?? '';
    const otherScope = entries.find(({ scopeKey }) => scopeKey === 'session:s1')?.id ?? '';
    expect(await memory.forget({ agentName: 'helper', scopeKey: 'agent', ids: [mine, otherScope, 'unknown', mine] })).toEqual({ forgotten: [mine], notFound: [otherScope, 'unknown'], kept: [] });
    expect(await memory.forget({ agentName: 'helper', scopeKey: 'agent', ids: [mine] })).toEqual({ forgotten: [], notFound: [mine], kept: [] });
    expect(await store.get('memory', 'unknown')).toBeUndefined();
    expect((await memory.recall({ agentName: 'helper', scopeKey: 'agent', query: 'lint', limit: 5 })).memories).toEqual([]);
    expect((await memory.recall({ agentName: 'helper', scopeKey: 'session:s1', query: 'lint', limit: 5 })).memories).toHaveLength(1);
    await memory.save(note('lint before committing'));
    expect((await memory.recall({ agentName: 'helper', scopeKey: 'agent', query: 'lint', limit: 5 })).memories.map(({ id }) => id)).toEqual([mine]);
  });
});
