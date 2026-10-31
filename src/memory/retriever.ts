import { describeError } from '../core/describe-value.js';
import { createBm25 } from '../knowledge/bm25.js';
import type { MemoryEntry, MemoryRetriever } from './memory-types.js';
import { contentTerms } from './stop-words.js';

export interface RelevanceParams {
  query: string;
  /** The entries recall may show. */
  entries: MemoryEntry[];
  retriever?: MemoryRetriever;
  /** Told when the retriever fails (recall then falls back to keywords). */
  onProblem?(message: string): void;
}

/** BM25 over each entry's text and tags, stop words left out of both sides. */
function keywordRelevance(params: { query: string; entries: MemoryEntry[] }): Map<string, number> {
  const { query, entries } = params;
  const index = createBm25(entries.map(({ id, text, tags }) => ({ id, text: contentTerms([text, ...tags].join(' ')).join(' ') })));
  return new Map(index.search({ query: contentTerms(query).join(' '), k: entries.length }).map(({ id, score }) => [id, score]));
}

/** How relevant each entry is to the query (absent: not at all): the consumer's retriever, else BM25 keywords. */
export async function relevanceScores(params: RelevanceParams): Promise<Map<string, number>> {
  const { query, entries, retriever, onProblem } = params;
  if (entries.length === 0) return new Map();
  if (retriever == null) return keywordRelevance({ query, entries });
  try {
    const known = new Set(entries.map(({ id }) => id));
    const ranked = await retriever.rank(query, entries.map(entry => structuredClone(entry)));
    // Only finite, positive scores for entries recall offered count; anything else from the retriever is ignored.
    return new Map(ranked.filter(({ id, score }) => known.has(id) && Number.isFinite(score) && score > 0).map(({ id, score }) => [id, score]));
  } catch (error) {
    onProblem?.(`Memory retriever failed, recall fell back to keywords: ${describeError(error)}`);
    return keywordRelevance({ query, entries });
  }
}
