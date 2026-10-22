import { hashEmbedder } from './embedder.js';
import { fixtureSources, JUDGMENTS } from './fixtures.test-support.js';
import type { RelevanceJudgment } from './fixtures.test-support.js';
import { createKnowledgeBase } from './knowledge-base.js';
import type { Embedder, KnowledgeBase, KnowledgeBaseOptions, SearchMode } from './knowledge-types.js';
import { createMemoryVectorIndex } from './memory-vector-index.js';

/** An embedder that counts calls and texts. */
export interface CountingEmbedder extends Embedder {
  calls: string[][];
}

export function countingEmbedder(inner: Embedder = hashEmbedder()): CountingEmbedder {
  const calls: string[][] = [];
  return { id: inner.id, dimensions: inner.dimensions, calls, embed: async (texts, signal) => {
    calls.push([...texts]);
    return inner.embed(texts, signal);
  } };
}

/** A knowledge base over the fixture corpus (memory index, counting hash embedder). */
export async function fixtureBase(overrides: Partial<KnowledgeBaseOptions> = {}): Promise<{ base: KnowledgeBase; embedder: CountingEmbedder }> {
  const embedder = countingEmbedder();
  const base = createKnowledgeBase({ embedder, index: createMemoryVectorIndex(), ...overrides });
  await base.index({ sources: fixtureSources() });
  return { base, embedder };
}

/** Recall@k and MRR (by source id) of a mode over judgments. */
export async function measure(params: { base: KnowledgeBase; mode: SearchMode; k: number; judgments?: RelevanceJudgment[] }): Promise<{ recall: number; mrr: number }> {
  const { base, mode, k, judgments = JUDGMENTS } = params;
  let recall = 0;
  let mrr = 0;
  for (const { query, relevant } of judgments) {
    const results = await base.search({ query, k, mode });
    const ids = results.map(({ sourceId }) => sourceId);
    if (ids.some(id => relevant.includes(id))) recall += 1;
    const rank = ids.findIndex(id => relevant.includes(id));
    mrr += rank < 0 ? 0 : 1 / (rank + 1);
  }
  return { recall: recall / judgments.length, mrr: mrr / judgments.length };
}
