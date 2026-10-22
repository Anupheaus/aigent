import { createAigentError } from '../core/aigent-error.js';
import { createBm25 } from './bm25.js';
import type { Bm25Index } from './bm25.js';
import { fuseRankings } from './hybrid-search.js';
import type { Ranked } from './hybrid-search.js';
import type { Embedder, IndexedChunk, SearchMode, SearchRequest, SearchResult, VectorIndex } from './knowledge-types.js';
import { collapseNearDuplicates, mmrSelect } from './mmr.js';
import type { DiversityCandidate } from './mmr.js';
import { snippetFor } from './snippet.js';
import { matchesMetadata } from './vector-index.js';

/** Most results one search returns. */
export const MAX_SEARCH_K = 20;
const DEFAULT_SEARCH_K = 5;
/** Candidates each ranking contributes to the fusion. */
const CANDIDATES_PER_RANKING = 50;
const MODES: readonly SearchMode[] = ['hybrid', 'vector', 'keyword'];

/** What search works with; the keyword index is rebuilt only when the vector index's version changes. */
export interface SearchDeps {
  embedder: Embedder;
  index: VectorIndex;
  keywordCache: { version?: string; bm25?: Bm25Index; chunks?: Map<string, IndexedChunk> };
}

function invalid(message: string): never {
  throw createAigentError({ code: 'invalid_input', message: `knowledge search: ${message}` });
}

function checkRequest(request: SearchRequest): { k: number; mode: SearchMode } {
  const { query, k = DEFAULT_SEARCH_K, mode = 'hybrid', mmrLambda } = request ?? {};
  if (typeof query !== 'string' || query.trim() === '') invalid('query must be non-empty text');
  if (!Number.isSafeInteger(k) || k < 1 || k > MAX_SEARCH_K) invalid(`k must be an integer from 1 to ${MAX_SEARCH_K}, got ${String(k)}`);
  if (!MODES.includes(mode)) invalid(`mode must be one of ${MODES.join(', ')}, got ${String(mode)}`);
  if (mmrLambda != null && (typeof mmrLambda !== 'number' || mmrLambda < 0 || mmrLambda > 1)) invalid(`mmrLambda must be from 0 to 1, got ${String(mmrLambda)}`);
  return { k, mode };
}

/** Every chunk by id and the BM25 index over them, rebuilt only when the index's version changed. */
async function keywordIndex(deps: SearchDeps): Promise<{ bm25: Bm25Index; chunks: Map<string, IndexedChunk> }> {
  const { index, keywordCache } = deps;
  const version = await index.version();
  if (keywordCache.version !== version || keywordCache.bm25 == null || keywordCache.chunks == null) {
    const chunks = await index.list();
    keywordCache.chunks = new Map(chunks.map(chunk => [chunk.chunkId, chunk]));
    keywordCache.bm25 = createBm25(chunks.map(({ chunkId, text }) => ({ id: chunkId, text })));
    keywordCache.version = version;
  }
  return { bm25: keywordCache.bm25, chunks: keywordCache.chunks };
}

async function rankings(params: { deps: SearchDeps; request: SearchRequest; mode: SearchMode; chunks: Map<string, IndexedChunk>; bm25: Bm25Index }): Promise<Ranked[]> {
  const { deps: { embedder, index }, request: { query, filter, signal }, mode, chunks, bm25 } = params;
  const lists: Ranked[][] = [];
  if (mode !== 'keyword') {
    const [vector] = await embedder.embed([query], signal);
    const nearest = await index.query({ vector: vector ?? [], k: CANDIDATES_PER_RANKING, embedderId: embedder.id, ...(filter == null ? {} : { filter }) });
    // Defence in depth for indexes that ignore `embedderId`: another embedder's vectors are never compared.
    lists.push(nearest.filter(({ chunkId }) => chunks.get(chunkId)?.embedderId === embedder.id));
  }
  if (mode !== 'vector') {
    // Over-fetch, then filter: BM25 scores do not depend on the filter, so the order is unchanged.
    const keyword = bm25.search({ query, k: chunks.size }).filter(({ id }) => {
      const chunk = chunks.get(id);
      return chunk != null && matchesMetadata({ chunk, ...(filter == null ? {} : { filter }) });
    });
    lists.push(keyword.slice(0, CANDIDATES_PER_RANKING).map(({ id, score }) => ({ chunkId: id, score })));
  }
  return mode === 'hybrid' ? fuseRankings(lists) : (lists[0] ?? []);
}

/**
 * Hybrid search (see `SearchRequest`): vector and BM25 top-50 fused by reciprocal rank, an optional rerank, near
 * duplicates collapsed, then MMR (with `mmrLambda`) or the top `k`. Ties break by chunk id, so a query on the same index
 * version always gives the same results.
 */
export async function searchKnowledge(params: { deps: SearchDeps; request: SearchRequest }): Promise<SearchResult[]> {
  const { deps, request } = params;
  const { k, mode } = checkRequest(request);
  const { bm25, chunks } = await keywordIndex(deps);
  const ranked = await rankings({ deps, request, mode, chunks, bm25 });
  let candidates: DiversityCandidate[] = ranked.flatMap(({ chunkId, score }) => {
    const chunk = chunks.get(chunkId);
    // A stale chunk found by keyword keeps its place, but its vector (another embedder's space) is not used for MMR.
    const hasComparableVector = chunk?.vector != null && chunk.embedderId === deps.embedder.id;
    return chunk == null ? [] : [{ chunkId, score, text: chunk.text, ...(hasComparableVector ? { vector: chunk.vector } : {}) }];
  });
  if (request.rerank != null) {
    const byId = new Map(candidates.map(candidate => [candidate.chunkId, candidate]));
    const reranked = await request.rerank(request.query, candidates.map(({ chunkId, text, score }) => ({ chunkId, text, score })));
    candidates = reranked.flatMap(({ chunkId, score }) => {
      const candidate = byId.get(chunkId);
      return candidate == null ? [] : [{ ...candidate, score }];
    });
  }
  const distinct = collapseNearDuplicates(candidates);
  const picked = request.mmrLambda == null ? distinct.slice(0, k) : mmrSelect({ candidates: distinct, k, lambda: request.mmrLambda });
  return picked.map(({ chunkId, score }) => {
    const { sourceId, uri, span, text } = chunks.get(chunkId) as IndexedChunk;
    return { chunkId, sourceId, uri, span, score, snippet: snippetFor({ text, query: request.query }), citation: { sourceId, chunkId, uri, span } };
  });
}
