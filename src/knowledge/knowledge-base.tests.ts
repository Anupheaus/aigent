import { describe, expect, it } from 'vitest';
import { createMemoryFsAccess } from '../security/fs-access-memory.js';
import type { FsAccess } from '../security/fs-access.js';
import { createFsPolicy } from '../security/fs-policy.js';
import { createChunker } from './chunker.js';
import { hashEmbedder } from './embedder.js';
import { fixtureSources, JUDGMENTS } from './fixtures.test-support.js';
import { createKnowledgeBase } from './knowledge-base.js';
import { countingEmbedder, fixtureBase, measure } from './knowledge-base.test-support.js';
import type { Embedder, KnowledgeSource } from './knowledge-types.js';
import { createMemoryVectorIndex } from './memory-vector-index.js';
import { scanSources } from './source-scan.js';

/** Declared from the measured baseline (hybrid, 256-dim hashEmbedder: recall@5 0.93, MRR 0.91), with a small margin. */
const MIN_HYBRID_RECALL_AT_5 = 0.9;
const MIN_HYBRID_MRR = 0.88;
const IDENTIFIER_JUDGMENTS = JUDGMENTS.filter(({ query }) => !query.includes(' '));

describe('retrieval quality on the fixture corpus', () => {
  it(`reaches recall@5 >= ${MIN_HYBRID_RECALL_AT_5} and MRR >= ${MIN_HYBRID_MRR} with hybrid search`, async () => {
    const { base } = await fixtureBase();
    const { recall, mrr } = await measure({ base, mode: 'hybrid', k: 5 });
    expect(recall).toBeGreaterThanOrEqual(MIN_HYBRID_RECALL_AT_5);
    expect(mrr).toBeGreaterThanOrEqual(MIN_HYBRID_MRR);
  });

  it('ranks the exact-identifier document first, and beats pure vector search on identifiers with a weak embedder', async () => {
    const { base } = await fixtureBase({ embedder: countingEmbedder(hashEmbedder({ dimensions: 16 })) });
    const hybrid = await measure({ base, mode: 'hybrid', k: 5, judgments: IDENTIFIER_JUDGMENTS });
    const vector = await measure({ base, mode: 'vector', k: 5, judgments: IDENTIFIER_JUDGMENTS });
    expect(hybrid.mrr).toBe(1);
    expect(hybrid.mrr).toBeGreaterThan(vector.mrr);
    expect((await base.search({ query: 'parseConfigFile', k: 1 }))[0]?.sourceId).toBe('parse-config.ts');
    expect((await base.search({ query: 'createConnectionPool', k: 1, mode: 'keyword' }))[0]?.sourceId).toBe('db-pool.ts');
  });

  it('collapses near-duplicate chunks', async () => {
    const { base } = await fixtureBase();
    const ids = (await base.search({ query: 'retried with exponential backoff MAX_RETRY_COUNT', k: 10 })).map(({ sourceId }) => sourceId);
    expect(ids.filter(id => id === 'retry.md' || id === 'faq-retry-copy.md')).toHaveLength(1);
  });

  it('restricts results with metadata filters, and returns citations and short snippets', async () => {
    const { base } = await fixtureBase();
    const results = await base.search({ query: 'how much does it cost', k: 10, filter: { topic: 'billing' } });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.sourceId).toMatch(/^billing-/);
      expect(result.citation).toEqual({ sourceId: result.sourceId, chunkId: result.chunkId, uri: result.uri, span: result.span });
      expect(result.snippet.length).toBeLessThanOrEqual(400);
    }
    expect(await base.search({ query: 'cost', filter: { sourceId: 'billing-plans.md' } })).toEqual([expect.objectContaining({ sourceId: 'billing-plans.md' })]);
  });

  it('applies a rerank hook and MMR, and checks its arguments', async () => {
    const { base } = await fixtureBase();
    const reranked = await base.search({ query: 'retry', k: 3, rerank: async (_query, candidates) => [...candidates].reverse() });
    const plain = await base.search({ query: 'retry', k: 3 });
    expect(reranked.map(({ chunkId }) => chunkId)).not.toEqual(plain.slice(0, 3).map(({ chunkId }) => chunkId));
    expect(await base.search({ query: 'retry', k: 3, mmrLambda: 0.3 })).toHaveLength(3);
    await expect(base.search({ query: 'x', k: 21 })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(base.search({ query: ' ' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('determinism and versions', () => {
  it('gives byte-identical results for the same query and index version', async () => {
    const { base } = await fixtureBase();
    const first = JSON.stringify(await base.search({ query: 'database backups', k: 8 }));
    const { base: other } = await fixtureBase();
    expect(JSON.stringify(await base.search({ query: 'database backups', k: 8 }))).toBe(first);
    expect(JSON.stringify(await other.search({ query: 'database backups', k: 8 }))).toBe(first);
    expect(await other.version()).toBe(await base.version());
  });

  it('changes version when content or the embedder changes, not on a no-op re-index', async () => {
    const { base } = await fixtureBase();
    const before = await base.version();
    await base.index({ sources: fixtureSources() });
    expect(await base.version()).toBe(before);
    await base.index({ sources: [{ id: 'install.md', uri: 'docs/install.md', text: '# Installing\n\nUse pnpm add lumen.' }] });
    expect(await base.version()).not.toBe(before);
    const { base: otherEmbedder } = await fixtureBase({ embedder: countingEmbedder(hashEmbedder({ dimensions: 64 })) });
    expect(await otherEmbedder.version()).not.toBe(before);
  });
});

describe('freshness', () => {
  const long = (label: string) => Array.from({ length: 30 }, (_, index) => `Paragraph ${index} of ${label} explains one more detail about the system in plain words.`).join('\n\n');

  it('skips unchanged sources, re-embeds only changed chunks, and drops removed ones', async () => {
    const embedder = countingEmbedder();
    const base = createKnowledgeBase({ embedder, index: createMemoryVectorIndex() });
    const first = await base.index({ sources: [{ id: 'a', uri: 'a.txt', text: long('a') }, { id: 'b', uri: 'b.txt', text: 'Short b.' }] });
    expect(first).toMatchObject({ indexed: ['a', 'b'], skipped: [] });
    expect(first.embedded).toBeGreaterThan(2);
    expect(embedder.calls).toHaveLength(2);

    const unchanged = await base.index({ sources: [{ id: 'a', uri: 'a.txt', text: long('a') }, { id: 'b', uri: 'b.txt', text: 'Short b.' }] });
    expect(unchanged).toMatchObject({ indexed: [], skipped: ['a', 'b'], embedded: 0 });
    expect(embedder.calls).toHaveLength(2);

    const edited = long('a').replace('Paragraph 29 of a', 'Paragraph twenty-nine, now rewritten, of a');
    const changed = await base.index({ sources: [{ id: 'a', uri: 'a.txt', text: edited }] });
    expect(changed.indexed).toEqual(['a']);
    expect(changed.embedded).toBe(1);
    expect(embedder.calls.at(-1)).toHaveLength(1);
    expect(changed.chunksRemoved).toBe(1);

    await base.remove({ sourceIds: ['b'] });
    expect(await base.search({ query: 'Short b', k: 5, filter: { sourceId: 'b' } })).toEqual([]);
    const pruned = await base.index({ sources: [{ id: 'renamed', uri: 'renamed.txt', text: edited }], prune: true });
    expect(pruned).toMatchObject({ indexed: ['renamed'], removed: ['a'] });
    expect(pruned.embedded).toBe(0);
    expect((await base.search({ query: 'paragraph', k: 20 })).every(({ sourceId }) => sourceId === 'renamed')).toBe(true);
  });

  it('re-indexes unchanged text whose uri or metadata changed, without re-embedding (review I2)', async () => {
    const embedder = countingEmbedder();
    const base = createKnowledgeBase({ embedder, index: createMemoryVectorIndex() });
    await base.index({ sources: [{ id: 'a', uri: 'tenant-a/a.txt', text: long('a'), metadata: { tenant: 'a' } }] });
    const before = await base.version();
    const calls = embedder.calls.length;
    const moved = await base.index({ sources: [{ id: 'a', uri: 'tenant-b/a.txt', text: long('a'), metadata: { tenant: 'b' } }] });
    expect(moved).toMatchObject({ indexed: ['a'], skipped: [], embedded: 0 });
    expect(embedder.calls).toHaveLength(calls);
    expect(await base.version()).not.toBe(before);
    expect(await base.search({ query: 'paragraph detail', filter: { tenant: 'a' } })).toEqual([]);
    const forB = await base.search({ query: 'paragraph detail', filter: { tenant: 'b' } });
    expect(forB.length).toBeGreaterThan(0);
    expect(forB.every(({ uri }) => uri === 'tenant-b/a.txt')).toBe(true);
  });

  it('re-indexes a source when the chunker settings change (review I2)', async () => {
    const index = createMemoryVectorIndex();
    const source = { id: 'a', uri: 'a.txt', text: long('a') };
    await createKnowledgeBase({ embedder: hashEmbedder(), index }).index({ sources: [source] });
    const report = await createKnowledgeBase({ embedder: hashEmbedder(), index, chunker: createChunker({ targetChars: 300, overlapChars: 0 }) }).index({ sources: [source] });
    expect(report).toMatchObject({ indexed: ['a'], skipped: [] });
  });

  it('re-indexes a path source with an unchanged mtime when its metadata changed (review I2)', async () => {
    const access = createMemoryFsAccess({ platform: 'posix', files: { '/kb/guide.md': '# Guide\n\nThe guide text.' } });
    const policy = createFsPolicy({ roots: [{ path: '/kb', permissions: ['read'] }] });
    const base = createKnowledgeBase({ embedder: hashEmbedder(), index: createMemoryVectorIndex(), fs: { access, policy } });
    await base.index({ sources: [{ id: 'guide', uri: 'guide.md', path: '/kb/guide.md', metadata: { tenant: 'a' } }] });
    const report = await base.index({ sources: [{ id: 'guide', uri: 'guide.md', path: '/kb/guide.md', metadata: { tenant: 'b' } }] });
    expect(report).toMatchObject({ indexed: ['guide'], skipped: [] });
    expect(await base.search({ query: 'guide', filter: { tenant: 'b' } })).not.toEqual([]);
  });

  it('never scores vectors of another embedder against the query, and reports their sources as stale (review I3)', async () => {
    const index = createMemoryVectorIndex();
    const sources = [{ id: 'a', uri: 'a.txt', text: 'Alpha notes about deployment pipelines.' }, { id: 'b', uri: 'b.txt', text: 'Beta notes about database backups.' }];
    await createKnowledgeBase({ embedder: hashEmbedder(), index }).index({ sources });
    // Same dimensions, another model: its vectors live in a different space.
    const inner = hashEmbedder();
    const other: Embedder = { id: 'other-model', dimensions: inner.dimensions, embed: async (texts, signal) => (await inner.embed(texts, signal)).map(vector => vector.map(value => -value)) };
    const base = createKnowledgeBase({ embedder: other, index });
    await base.index({ sources: [sources[1] as KnowledgeSource] });
    const vectorHits = await base.search({ query: 'alpha deployment pipelines', mode: 'vector', k: 5 });
    expect(vectorHits.map(({ sourceId }) => sourceId)).toEqual(['b']);
    expect(await base.staleSources()).toEqual(['a']);
    // Keyword ranking does not depend on the embedder, so the stale source stays findable by its words.
    expect((await base.search({ query: 'alpha', mode: 'keyword' })).map(({ sourceId }) => sourceId)).toEqual(['a']);
  });

  it('keeps chunk ids stable across runs for unchanged text', async () => {
    const ids = async () => {
      const base = createKnowledgeBase({ embedder: hashEmbedder(), index: createMemoryVectorIndex() });
      await base.index({ sources: [{ id: 'a', uri: 'a.md', text: long('a') }] });
      return (await base.search({ query: 'paragraph detail', k: 20 })).map(({ chunkId }) => chunkId).sort();
    };
    expect(await ids()).toEqual(await ids());
  });

  it('indexes path sources through the policy, skips unchanged mtimes without reading, and refuses paths outside the roots', async () => {
    const disk = createMemoryFsAccess({ platform: 'posix', files: { '/kb/guide.md': '# Guide\n\nThe guide text.', '/kb/.env': 'SECRET=1', '/kb/sub/notes.txt': 'Notes about deployment.', '/private/x.md': 'hidden' } });
    let reads = 0;
    const access: FsAccess = { ...disk, readFile: async path => { reads += 1; return disk.readFile(path); } };
    const policy = createFsPolicy({ roots: [{ path: '/kb', permissions: ['read'] }] });
    const embedder = countingEmbedder();
    const base = createKnowledgeBase({ embedder, index: createMemoryVectorIndex(), fs: { access, policy } });
    const sources = await scanSources({ access, policy, root: '/kb' });
    expect(sources.map(({ id }) => id)).toEqual(['guide.md', 'sub/notes.txt']);
    const report = await base.index({ sources: [...sources, { id: 'x', uri: 'x.md', path: '/private/x.md' }] });
    expect(report.indexed).toEqual(['guide.md', 'sub/notes.txt']);
    expect(report.failed).toEqual([expect.objectContaining({ sourceId: 'x', code: 'outside_roots' })]);
    const readsBefore = reads;
    expect((await base.index({ sources })).skipped).toEqual(['guide.md', 'sub/notes.txt']);
    expect(reads).toBe(readsBefore);
    await disk.rm('/kb/guide.md');
    const gone = await base.index({ sources });
    expect(gone.failed.map(({ sourceId }) => sourceId)).toEqual(['guide.md']);
    expect(await base.search({ query: 'guide', filter: { sourceId: 'guide.md' } })).toEqual([]);
  });

  it('refuses to scan past the policy maxFiles instead of truncating, so a pruning index never drops files silently (review M8)', async () => {
    const access = createMemoryFsAccess({ platform: 'posix', files: { '/kb/a.md': 'a', '/kb/b.md': 'b', '/kb/c.md': 'c' } });
    const policy = createFsPolicy({ roots: [{ path: '/kb', permissions: ['read'] }], maxFiles: 2 });
    await expect(scanSources({ access, policy, root: '/kb' })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/more than 2 files.*maxFiles/) });
    const exact = createFsPolicy({ roots: [{ path: '/kb', permissions: ['read'] }], maxFiles: 3 });
    expect((await scanSources({ access, policy: exact, root: '/kb' })).map(({ id }) => id)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('reads a chunk with its neighbours, by id or by span', async () => {
    const base = createKnowledgeBase({ embedder: hashEmbedder(), index: createMemoryVectorIndex() });
    await base.index({ sources: [{ id: 'a', uri: 'a.txt', text: long('a') }] });
    const all = await Promise.all((await base.search({ query: 'paragraph', k: 20, filter: { sourceId: 'a' } })).map(({ chunkId }) => base.read(chunkId)));
    const middle = all.find(result => result?.prev != null && result.next != null);
    expect(middle).toBeDefined();
    const bySpan = await base.read({ sourceId: 'a', span: middle?.chunk.span ?? { start: 0, end: 0 } });
    expect(bySpan?.chunk.chunkId).toBe(middle?.chunk.chunkId);
    expect(await base.read('nope')).toBeUndefined();
  });
});
