import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { recallMemories } from './recall.js';
import type { RecallParams } from './recall.js';
import { FIXTURE_MEMORIES, FIXTURE_NOW, FIXTURE_QUERIES, fixtureEntry } from './recall-fixtures.test-support.js';
import { MEMORY_COLLECTION } from './memory-types.js';
import type { MemoryEntry, MemoryRetriever } from './memory-types.js';

const DAY_MS = 86_400_000;
const MIN_TOP_ONE = 0.9;
const MIN_MRR = 0.9;

async function storeWith(entries: MemoryEntry[]): Promise<Store> {
  const store = createInMemoryStore();
  for (const entry of entries) await store.compareAndSet({ collection: MEMORY_COLLECTION, key: entry.id, expectedVersion: undefined, value: entry });
  return store;
}

function recall(params: Partial<RecallParams> & { store: Store; query: string }) {
  return recallMemories({ agentName: 'helper', scopeKey: 'agent', limit: 6, now: FIXTURE_NOW, ...params });
}

describe('recallMemories', () => {
  it(`ranks the labelled memory first (top-1 >= ${MIN_TOP_ONE}, MRR >= ${MIN_MRR})`, async () => {
    const store = await storeWith(FIXTURE_MEMORIES.map(memory => fixtureEntry(memory)));
    let hits = 0;
    let reciprocalRanks = 0;
    for (const { query, expected } of FIXTURE_QUERIES) {
      const ids = (await recall({ store, query, limit: 10 })).map(({ id }) => id);
      if (ids[0] === expected) hits += 1;
      const rank = ids.indexOf(expected);
      reciprocalRanks += rank < 0 ? 0 : 1 / (rank + 1);
    }
    expect(hits / FIXTURE_QUERIES.length).toBeGreaterThanOrEqual(MIN_TOP_ONE);
    expect(reciprocalRanks / FIXTURE_QUERIES.length).toBeGreaterThanOrEqual(MIN_MRR);
  });

  it('leaves out memories with nothing in common with the task', async () => {
    const store = await storeWith(FIXTURE_MEMORIES.map(memory => fixtureEntry(memory)));
    expect(await recall({ store, query: 'xylophone quartz' })).toEqual([]);
    // Sharing only stop words ("the", "in") is not relatedness.
    expect(await recall({ store, query: 'the xylophone in the quartz' })).toEqual([]);
  });

  it('prefers the recent, the confident and the used, among equally relevant memories', async () => {
    const text = 'deploy with the script';
    const store = await storeWith([
      fixtureEntry({ id: 'old', text, updatedAt: FIXTURE_NOW - 30 * DAY_MS }),
      fixtureEntry({ id: 'fresh', text }),
      fixtureEntry({ id: 'confident', text, confidence: 0.9 }),
      fixtureEntry({ id: 'used', text, uses: 20, lastUsedAt: FIXTURE_NOW }),
    ]);
    expect((await recall({ store, query: 'deploy' })).map(({ id }) => id)).toEqual(['confident', 'used', 'fresh', 'old']);
  });

  it('breaks exact ties by the later update, then by id, the same way every time', async () => {
    const store = await storeWith([fixtureEntry({ id: 'b', text: 'lint' }), fixtureEntry({ id: 'a', text: 'lint' }), fixtureEntry({ id: 'c', text: 'lint', updatedAt: FIXTURE_NOW + 1 })]);
    const first = (await recall({ store, query: 'lint' })).map(({ id }) => id);
    expect(first).toEqual(['c', 'a', 'b']);
    expect((await recall({ store, query: 'lint' })).map(({ id }) => id)).toEqual(first);
  });

  it('never recalls forgotten, evicted, expired or faded memories; pinned ones never fade but must still be related', async () => {
    const store = await storeWith([
      fixtureEntry({ id: 'forgotten', text: 'lint rule', removed: { at: 1, reason: 'forgotten' } }),
      fixtureEntry({ id: 'evicted', text: 'lint rule', removed: { at: 1, reason: 'evicted' } }),
      fixtureEntry({ id: 'expired', text: 'lint rule', expiresAt: FIXTURE_NOW }),
      // 0.6 halved four times over 120 days is 0.0375, under the 0.2 floor.
      fixtureEntry({ id: 'faded', text: 'lint rule', updatedAt: FIXTURE_NOW - 120 * DAY_MS }),
      fixtureEntry({ id: 'pinned-stale', text: 'lint rule', pinned: true, updatedAt: FIXTURE_NOW - 120 * DAY_MS }),
      fixtureEntry({ id: 'pinned-unrelated', text: 'always answer in French', pinned: true }),
      fixtureEntry({ id: 'live', text: 'lint rule' }),
    ]);
    expect((await recall({ store, query: 'lint' })).map(({ id }) => id)).toEqual(['live', 'pinned-stale']);
  });

  it('keeps agents and scopes apart', async () => {
    const store = await storeWith([
      fixtureEntry({ id: 'mine', text: 'lint' }),
      fixtureEntry({ id: 'other-agent', text: 'lint', agentName: 'other' }),
      fixtureEntry({ id: 'other-scope', text: 'lint', scopeKey: 'session:s1' }),
    ]);
    expect((await recall({ store, query: 'lint' })).map(({ id }) => id)).toEqual(['mine']);
    expect((await recall({ store, query: 'lint', scopeKey: 'session:s1' })).map(({ id }) => id)).toEqual(['other-scope']);
    expect((await recall({ store, query: 'lint', agentName: 'other' })).map(({ id }) => id)).toEqual(['other-agent']);
  });

  it('returns at most limit memories', async () => {
    const store = await storeWith(Array.from({ length: 9 }, (_unused, index) => fixtureEntry({ id: `m${index}`, text: 'lint' })));
    expect(await recall({ store, query: 'lint', limit: 4 })).toHaveLength(4);
  });

  it('takes relevance from a retriever, and falls back to keywords (saying so) when it fails', async () => {
    const store = await storeWith([fixtureEntry({ id: 'keyword', text: 'lint' }), fixtureEntry({ id: 'semantic', text: 'eslint configuration' })]);
    const retriever: MemoryRetriever = { rank: async () => [{ id: 'semantic', score: 2 }, { id: 'keyword', score: 1 }] };
    expect((await recall({ store, query: 'lint', retriever })).map(({ id }) => id)).toEqual(['semantic', 'keyword']);
    const problems: string[] = [];
    const failing: MemoryRetriever = { rank: async () => { throw new Error('embedder offline'); } };
    expect((await recall({ store, query: 'lint', retriever: failing, onProblem: problem => problems.push(problem) })).map(({ id }) => id)).toEqual(['keyword']);
    expect(problems).toEqual(['Memory retriever failed, recall fell back to keywords: embedder offline']);
  });
});
