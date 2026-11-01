import { createAigentError } from '../core/aigent-error.js';
import { describeError } from '../core/describe-value.js';
import { RRF_K } from '../knowledge/hybrid-search.js';
import type { Embedder } from '../knowledge/knowledge-types.js';
import { cosine } from '../knowledge/vector-math.js';
import type { Store } from '../store/store-types.js';
import { embeddableOf, loadVectors, storeVectors } from './embedding-cache.js';
import type { EmbeddableEntry } from './embedding-cache.js';
import type { MemoryEntry, MemoryRank, MemoryRetriever } from './memory-types.js';
import { keywordRelevance } from './retriever.js';
import { scrubMemoryText } from './scrub-memory-text.js';

/** `embeddingRetriever(options)`. */
export interface EmbeddingRetrieverOptions {
  embedder: Embedder;
  /**
   * Where the memories' vectors are kept (collection `memory-vectors`, one per entry): give the same store as
   * `createAigent`, so forgetting, eviction and `ai.purge` remove a memory's vector with the memory.
   */
  store: Store;
  /** Cosine similarity below which the embedder's opinion is "unrelated" (default 0.3). */
  minSimilarity?: number;
  /**
   * The whole ranking (store reads, embedding, writes) is given up after this long, and recall uses keywords (default
   * 5000). Batches of memories embedded before then are kept for the next recall.
   */
  timeoutMs?: number;
  /** Told about problems that do not stop the ranking (vectors that could not be stored). */
  onWarning?(message: string): void;
}

/**
 * A priori, not fitted to a fixture: embedding models used for retrieval put unrelated short texts around 0.1-0.2 and
 * paraphrases well above 0.3.
 */
const DEFAULT_MIN_SIMILARITY = 0.3;
const DEFAULT_TIMEOUT_MS = 5_000;
/**
 * Keyword matches count half as much as semantic ones at the same rank: they add exact names and ids the embedder may
 * blur, but a lone shared word should not outrank a paraphrase.
 */
const KEYWORD_WEIGHT = 0.5;
/** Memories embedded per request: small enough that a deadline loses little work, large enough to batch well. */
const EMBED_BATCH_SIZE = 16;

function failure(params: { embedder: Embedder; message: string }): Error {
  const { embedder, message } = params;
  return createAigentError({ code: 'provider_failed', message: `Memory embedder '${embedder.id}' ${message}`, details: { embedderId: embedder.id } });
}

/** Checks the embedder kept its promise: one finite vector of `dimensions` numbers per text. */
function checkVectors(params: { embedder: Embedder; vectors: number[][]; count: number }): void {
  const { embedder, vectors, count } = params;
  if (!Array.isArray(vectors) || vectors.length !== count) throw failure({ embedder, message: `returned ${Array.isArray(vectors) ? vectors.length : 'no'} vectors for ${count} texts` });
  for (const [position, vector] of vectors.entries()) {
    if (vector.length !== embedder.dimensions || !vector.every(Number.isFinite)) throw failure({ embedder, message: `returned a vector for text ${position + 1} that is not ${embedder.dimensions} finite numbers` });
  }
}

/** Positions in a best-first list, from 1. */
function ranksOf(scores: Map<string, number>): Map<string, number> {
  const ordered = [...scores].sort(([leftId, left], [rightId, right]) => right - left || (leftId < rightId ? -1 : 1));
  return new Map(ordered.map(([id], position) => [id, position + 1]));
}

/** Weighted reciprocal-rank fusion of the semantic and keyword rankings; an entry in neither is left out. */
function fuse(params: { semantic: Map<string, number>; keyword: Map<string, number> }): MemoryRank[] {
  const { semantic, keyword } = params;
  const semanticRanks = ranksOf(semantic);
  const keywordRanks = ranksOf(keyword);
  const ids = new Set([...semanticRanks.keys(), ...keywordRanks.keys()]);
  return [...ids].map(id => {
    const semanticRank = semanticRanks.get(id);
    const keywordRank = keywordRanks.get(id);
    const score = (semanticRank == null ? 0 : 1 / (RRF_K + semanticRank)) + (keywordRank == null ? 0 : KEYWORD_WEIGHT / (RRF_K + keywordRank));
    return { id, score };
  });
}

/**
 * Memory recall by meaning: each memory is embedded once (its vector stored by entry id with the embedder's id and
 * dimensions and a hash of the text, and used again only when all match), the task is embedded on every recall, and
 * memories at least `minSimilarity` alike are fused with BM25's keyword ranking. The query is embedded on its own and
 * new memories 16 at a time, each batch stored as it finishes, so a deadline keeps the work done before it. Only the stored, scrubbed text is
 * embedded, and the task is scrubbed of secrets before it is sent. A failing, malformed or slow embedder makes `rank`
 * throw, and recall then falls back to keywords with a warning: it never fails or stalls a run.
 */
export function embeddingRetriever(options: EmbeddingRetrieverOptions): MemoryRetriever {
  const { embedder, store, minSimilarity = DEFAULT_MIN_SIMILARITY, timeoutMs = DEFAULT_TIMEOUT_MS, onWarning } = options;

  async function embedChecked(params: { texts: string[]; signal: AbortSignal }): Promise<number[][]> {
    const { texts, signal } = params;
    let vectors: number[][];
    try {
      vectors = await embedder.embed(texts, signal);
    } catch (error) {
      throw failure({ embedder, message: `failed: ${describeError(error)}` });
    }
    checkVectors({ embedder, vectors, count: texts.length });
    return vectors;
  }

  /**
   * Embeds the missing entries a batch at a time and stores each batch as it finishes, so a deadline that cuts the
   * work short keeps what was done and the next recall carries on from there.
   */
  async function embedMissing(params: { missing: EmbeddableEntry[]; known: Map<string, number[]>; signal: AbortSignal }): Promise<void> {
    const { missing, known, signal } = params;
    for (let start = 0; start < missing.length; start += EMBED_BATCH_SIZE) {
      const batch = missing.slice(start, start + EMBED_BATCH_SIZE);
      const vectors = await embedChecked({ texts: batch.map(({ text }) => text), signal });
      // Past the deadline the recall has already fallen back: nothing more is written for it.
      if (signal.aborted) return;
      const embedded = batch.map((embeddable, position) => ({ embeddable, vector: vectors[position] ?? [] }));
      const problems = await storeVectors({ store, embedder, embedded });
      if (problems.length > 0) onWarning?.(`Memory vectors were not stored (they are embedded again next time): ${problems.join('; ')}`);
      for (const { embeddable: { entry }, vector } of embedded) known.set(entry.id, vector);
    }
  }

  async function semanticScores(params: { query: string; embeddables: EmbeddableEntry[]; signal: AbortSignal }): Promise<Map<string, number>> {
    const { query, embeddables, signal } = params;
    const known = await loadVectors({ store, embeddables, embedder });
    const [queryVector = []] = await embedChecked({ texts: [scrubMemoryText({ text: query })], signal });
    await embedMissing({ missing: embeddables.filter(({ entry }) => !known.has(entry.id)), known, signal });
    const scores = new Map<string, number>();
    for (const [id, vector] of known) {
      const similarity = cosine(queryVector, vector);
      if (similarity >= minSimilarity) scores.set(id, similarity);
    }
    return scores;
  }

  async function rank(query: string, entries: MemoryEntry[]): Promise<MemoryRank[]> {
    if (entries.length === 0) return [];
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(failure({ embedder, message: `took longer than ${timeoutMs} ms` }));
      }, timeoutMs);
    });
    const work = semanticScores({ query, embeddables: entries.map(embeddableOf), signal: controller.signal });
    // Whichever loses the race settles unobserved later; its rejection is not an unhandled one.
    work.catch(() => undefined);
    deadline.catch(() => undefined);
    try {
      const semantic = await Promise.race([work, deadline]);
      return fuse({ semantic, keyword: keywordRelevance({ query, entries }) });
    } finally {
      clearTimeout(timer);
    }
  }

  return { rank };
}
