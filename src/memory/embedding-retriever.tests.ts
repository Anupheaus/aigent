import { describe, expect, it } from 'vitest';
import type { Embedder } from '../knowledge/knowledge-types.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { embeddingRetriever } from './embedding-retriever.js';
import type { EmbeddingRetrieverOptions } from './embedding-retriever.js';
import { MEMORY_COLLECTION } from './memory-types.js';
import type { MemoryEntry } from './memory-types.js';
import { MEMORY_VECTOR_COLLECTION, readMemoryVector, writeMemoryVector } from './memory-vectors.js';
import { PARAPHRASE_QUERIES, conceptEmbedder } from './paraphrase-fixtures.test-support.js';
import { recallMemories } from './recall.js';
import type { RecallParams } from './recall.js';
import { FIXTURE_MEMORIES, FIXTURE_NOW, fixtureEntry } from './recall-fixtures.test-support.js';
import { contentTerms } from './stop-words.js';

/** Set before the fixture was run: embedding recall must put the labelled memory first for at least 8 of 10 paraphrases. */
const MIN_PARAPHRASE_TOP_ONE = 0.8;
const SHORT_TIMEOUT_MS = 50;

async function storeWith(entries: MemoryEntry[]): Promise<Store> {
  const store = createInMemoryStore();
  for (const entry of entries) await store.compareAndSet({ collection: MEMORY_COLLECTION, key: entry.id, expectedVersion: undefined, value: entry });
  return store;
}

function fixtureStore(): Promise<Store> {
  return storeWith(FIXTURE_MEMORIES.map(memory => fixtureEntry(memory)));
}

function recall(params: Partial<RecallParams> & { store: Store; query: string }) {
  return recallMemories({ agentName: 'helper', scopeKey: 'agent', limit: 10, now: FIXTURE_NOW, ...params });
}

async function topOneRate(params: { store: Store; retriever?: RecallParams['retriever'] }): Promise<number> {
  const { store, retriever } = params;
  let hits = 0;
  for (const { query, expected } of PARAPHRASE_QUERIES) {
    const [first] = await recall({ store, query, ...(retriever == null ? {} : { retriever }) });
    if (first?.id === expected) hits += 1;
  }
  return hits / PARAPHRASE_QUERIES.length;
}

function retrieverOver(params: Partial<EmbeddingRetrieverOptions> & { store: Store }) {
  return embeddingRetriever({ embedder: conceptEmbedder(), ...params });
}

describe('embeddingRetriever', () => {
  it('uses paraphrases that share no content word with the memory they ask for', () => {
    for (const { query, expected } of PARAPHRASE_QUERIES) {
      const memory = FIXTURE_MEMORIES.find(({ id }) => id === expected);
      if (memory == null) throw new Error(`no fixture memory '${expected}'`);
      const memoryTerms = new Set(contentTerms([memory.text, ...memory.tags].join(' ')));
      expect(contentTerms(query).filter(term => memoryTerms.has(term)), query).toEqual([]);
    }
  });

  it(`finds paraphrased memories that keyword recall misses (top-1 >= ${MIN_PARAPHRASE_TOP_ONE}, better than BM25)`, async () => {
    const store = await fixtureStore();
    const embedded = await topOneRate({ store, retriever: retrieverOver({ store }) });
    const keywords = await topOneRate({ store });
    expect(embedded).toBeGreaterThanOrEqual(MIN_PARAPHRASE_TOP_ONE);
    expect(embedded).toBeGreaterThan(keywords);
  });

  it('recalls nothing for a task unrelated to every memory', async () => {
    const store = await fixtureStore();
    expect(await recall({ store, query: 'xylophone quartz', retriever: retrieverOver({ store }) })).toEqual([]);
  });

  it('embeds each memory once: later recalls, and a new retriever on the same store, embed only the query', async () => {
    const store = await fixtureStore();
    const embedder = conceptEmbedder();
    await recall({ store, query: 'Ship the app to preprod', retriever: embeddingRetriever({ embedder, store }) });
    expect(embedder.embedded).toHaveLength(FIXTURE_MEMORIES.length + 1);
    expect((await store.list(MEMORY_VECTOR_COLLECTION)).length).toBe(FIXTURE_MEMORIES.length);
    embedder.embedded.length = 0;
    await recall({ store, query: 'Run the linter', retriever: embeddingRetriever({ embedder, store }) });
    expect(embedder.embedded).toEqual(['Run the linter']);
  });

  it('never uses a vector of another embedder, agent, scope or text: it embeds the entry again', async () => {
    const entry = fixtureEntry({ id: 'deploy', text: 'Deploy to staging with npm run deploy:staging' });
    const store = await storeWith([entry]);
    const planted = { memoryId: 'deploy', agentName: 'helper', scopeKey: 'agent', recordedAt: FIXTURE_NOW, embedderId: 'concept-v1', dimensions: 512, textHash: 'x', vector: new Array<number>(512).fill(1) };
    for (const mismatch of [{ embedderId: 'other-model' }, { dimensions: 3, vector: [1, 1, 1] }, { agentName: 'someone-else' }, { scopeKey: 'session:other' }, { textHash: 'stale' }]) {
      await writeMemoryVector({ store, record: { ...planted, ...mismatch } });
      const embedder = conceptEmbedder();
      await recall({ store, query: 'Ship the app to preprod', retriever: embeddingRetriever({ embedder, store }) });
      expect(embedder.embedded, JSON.stringify(mismatch)).toContain(entry.text);
      expect(await readMemoryVector({ store, memoryId: 'deploy' })).toMatchObject({ embedderId: 'concept-v1', dimensions: 512, agentName: 'helper', scopeKey: 'agent' });
    }
  });

  it('re-embeds an entry whose text changed', async () => {
    const store = await storeWith([fixtureEntry({ id: 'm', text: 'Deploy to staging' })]);
    const embedder = conceptEmbedder();
    const retriever = embeddingRetriever({ embedder, store });
    await recall({ store, query: 'ship it', retriever });
    const stored = await store.get<MemoryEntry>(MEMORY_COLLECTION, 'm');
    if (stored == null) throw new Error('entry exists');
    await store.compareAndSet({ collection: MEMORY_COLLECTION, key: 'm', expectedVersion: stored.version, value: { ...stored.value, text: 'Deploy to staging on Fridays' } });
    embedder.embedded.length = 0;
    await recall({ store, query: 'ship it', retriever });
    expect(embedder.embedded).toEqual(['ship it', 'Deploy to staging on Fridays']);
  });

  it('keeps recall scoped: another scope\'s or agent\'s memory is never recalled, however close its vector', async () => {
    const store = await storeWith([
      fixtureEntry({ id: 'mine', text: 'Lint with eslint --fix before committing' }),
      fixtureEntry({ id: 'other-scope', text: 'Deploy to staging with npm run deploy:staging', scopeKey: 'session:s2' }),
      fixtureEntry({ id: 'other-agent', text: 'Deploy to staging with npm run deploy:staging', agentName: 'other' }),
    ]);
    const embedder = conceptEmbedder();
    expect(await recall({ store, query: 'Ship the app to preprod', retriever: embeddingRetriever({ embedder, store }) })).toEqual([]);
    expect(embedder.embedded.join('\n')).not.toContain('Deploy');
  });

  it('falls back to keyword recall with a warning when the embedder fails', async () => {
    const store = await fixtureStore();
    const failing: Embedder = { id: 'broken', dimensions: 4, embed: async () => { throw new Error('embedding service unavailable'); } };
    const problems: string[] = [];
    const recalled = await recall({ store, query: 'Run the integration tests', retriever: embeddingRetriever({ embedder: failing, store }), onProblem: message => problems.push(message) });
    expect(recalled.map(({ id }) => id)).toEqual((await recall({ store, query: 'Run the integration tests' })).map(({ id }) => id));
    expect(problems).toEqual([expect.stringContaining('embedding service unavailable')]);
  });

  it('gives up on an embedder that hangs after timeoutMs, aborting it, and falls back to keywords', async () => {
    const store = await fixtureStore();
    let signalled: AbortSignal | undefined;
    const hanging: Embedder = { id: 'slow', dimensions: 4, embed: async (_texts, signal) => { signalled = signal; return new Promise<number[][]>(() => undefined); } };
    const problems: string[] = [];
    const started = Date.now();
    const recalled = await recall({ store, query: 'Run the integration tests', retriever: embeddingRetriever({ embedder: hanging, store, timeoutMs: SHORT_TIMEOUT_MS }), onProblem: message => problems.push(message) });
    expect(Date.now() - started).toBeLessThan(SHORT_TIMEOUT_MS * 20);
    expect(recalled[0]?.id).toBe('tests');
    expect(signalled?.aborted).toBe(true);
    expect(problems).toEqual([expect.stringContaining(`${SHORT_TIMEOUT_MS} ms`)]);
  });

  it('refuses vectors of the wrong size or count from the embedder, falling back to keywords', async () => {
    const store = await fixtureStore();
    for (const embed of [async (texts: string[]) => texts.map(() => [1, 0]), async () => [[1, 0, 0, 0]], async (texts: string[]) => texts.map(() => [Number.NaN, 0, 0, 0])]) {
      const problems: string[] = [];
      await recall({ store, query: 'Run the integration tests', retriever: embeddingRetriever({ embedder: { id: 'bad', dimensions: 4, embed }, store }), onProblem: message => problems.push(message) });
      expect(problems).toEqual([expect.stringContaining("embedder 'bad'")]);
    }
    expect(await store.list(MEMORY_VECTOR_COLLECTION)).toEqual([]);
  });

  it('never sends a secret to the embedder, from a stored entry or the task', async () => {
    const key = ['sk-proj-', 'AbCdEfGhIjKlMnOpQrStUvWx0123456789'].join('');
    // Planted directly, as an older version or another writer might have left it: saving would have scrubbed it.
    const store = await storeWith([fixtureEntry({ id: 'leak', text: `The deploy key is ${key}` })]);
    const embedder = conceptEmbedder();
    await recall({ store, query: `deploy with ${key}`, retriever: embeddingRetriever({ embedder, store }) });
    expect(embedder.embedded.length).toBe(2);
    expect(embedder.embedded.join('\n')).not.toContain(key);
    expect(JSON.stringify(await store.list(MEMORY_VECTOR_COLLECTION))).not.toContain(key);
  });

  it('drops the vector it wrote when the entry was forgotten while it was embedding', async () => {
    const entry = fixtureEntry({ id: 'm', text: 'Deploy to staging' });
    const store = await storeWith([entry]);
    const base = conceptEmbedder();
    const forgetting: Embedder = {
      ...base,
      embed: async texts => {
        const stored = await store.get<MemoryEntry>(MEMORY_COLLECTION, 'm');
        if (stored != null) await store.compareAndSet({ collection: MEMORY_COLLECTION, key: 'm', expectedVersion: stored.version, value: { ...stored.value, removed: { at: FIXTURE_NOW, reason: 'forgotten' } } });
        return base.embed(texts);
      },
    };
    await recall({ store, query: 'Ship it to preprod', retriever: embeddingRetriever({ embedder: forgetting, store }) });
    expect(await readMemoryVector({ store, memoryId: 'm' })).toBeUndefined();
  });

  it('still ranks by embeddings when the vectors cannot be stored, saying so', async () => {
    const base = await fixtureStore();
    const store: Store = { ...base, compareAndSet: async params => (params.collection === MEMORY_VECTOR_COLLECTION ? Promise.reject(new Error('disk full')) : base.compareAndSet(params)) };
    const warnings: string[] = [];
    const [first] = await recall({ store, query: 'Ship the app to preprod', retriever: embeddingRetriever({ embedder: conceptEmbedder(), store, onWarning: message => warnings.push(message) }) });
    expect(first?.id).toBe('deploy');
    expect(warnings).toEqual([expect.stringContaining('disk full')]);
  });
});
