import { createAigentError } from '../core/aigent-error.js';
import type { KnowledgeBase, MetadataFilter, SearchMode } from './knowledge-types.js';

const DEFAULT_EVAL_K = 5;

/** One labelled query: the source ids (or chunk ids) that answer it (any one of them is a hit). */
export interface RetrievalCase {
  query: string;
  relevant: string[];
  filter?: MetadataFilter;
}

/** How one case did. */
export interface RetrievalCaseResult {
  query: string;
  /** 1-based rank of the first relevant result, absent when none was in the top k. */
  rank?: number;
  /** Source ids of the results, in order. */
  results: string[];
}

/** `evalRetrieval`'s figures. */
export interface RetrievalEval {
  /**
   * Share of cases with at least one relevant result in the top k (a hit rate). `relevant` lists acceptable answers, so
   * with several ids a case counts once found, not by the share of its ids found.
   */
  recallAtK: number;
  /** Mean reciprocal rank of the first relevant result (0 for a miss). */
  mrr: number;
  perCase: RetrievalCaseResult[];
}

/**
 * Measures a knowledge base on labelled queries: recall@k and MRR, matching results by source id or chunk id. Use it
 * in tests to hold retrieval quality to a declared threshold as sources, chunking or embedders change.
 */
export async function evalRetrieval(params: { base: KnowledgeBase; cases: RetrievalCase[]; k?: number; mode?: SearchMode }): Promise<RetrievalEval> {
  const { base, cases, k = DEFAULT_EVAL_K, mode = 'hybrid' } = params;
  if (!Array.isArray(cases) || cases.length === 0) throw createAigentError({ code: 'invalid_input', message: 'evalRetrieval needs at least one case' });
  const perCase: RetrievalCaseResult[] = [];
  for (const { query, relevant, filter } of cases) {
    const results = await base.search({ query, k, mode, ...(filter == null ? {} : { filter }) });
    const index = results.findIndex(({ sourceId, chunkId }) => relevant.includes(sourceId) || relevant.includes(chunkId));
    perCase.push({ query, results: results.map(({ sourceId }) => sourceId), ...(index < 0 ? {} : { rank: index + 1 }) });
  }
  const hits = perCase.filter(({ rank }) => rank != null);
  return {
    recallAtK: hits.length / perCase.length,
    mrr: perCase.reduce((sum, { rank }) => sum + (rank == null ? 0 : 1 / rank), 0) / perCase.length,
    perCase,
  };
}
