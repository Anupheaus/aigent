import type { FsAccess } from '../security/fs-access.js';
import type { Citation } from '../core/citations.js';
import type { FsPolicy } from '../security/fs-policy-types.js';

/** Turns texts into vectors. `id` names the model and settings: vectors of different ids are never compared. */
export interface Embedder {
  id: string;
  dimensions: number;
  /** One vector of `dimensions` numbers per text, in order. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/** Metadata values a chunk carries and a filter compares (equality). */
export type MetadataValue = string | number | boolean;

/** Equality on chunk metadata; `sourceId` and `uri` match the chunk's own fields. Every entry must match. */
export type MetadataFilter = Record<string, MetadataValue>;

/** Where a chunk sits in its source: character offsets (end exclusive) and 1-based lines. */
export interface ChunkSpan {
  start: number;
  end: number;
  startLine?: number;
  endLine?: number;
}

/** One stored piece of a source. */
export interface IndexedChunk {
  /** sha-256 of sourceId, span and text: the same for unchanged text at the same place. */
  chunkId: string;
  sourceId: string;
  uri: string;
  span: ChunkSpan;
  text: string;
  metadata: Record<string, MetadataValue>;
  vector?: number[];
  /** sha-256 of `text`; an embedding is reused for any chunk with the same hash. */
  contentHash: string;
  /** sha-256 of the whole source text when indexed (freshness: an unchanged source is skipped). */
  sourceHash?: string;
  /** Path sources: the file's mtime when indexed (an unchanged mtime skips even reading the file). */
  sourceMtimeMs?: number;
  /** The `Embedder.id` that made `vector`: vectors are reused only by the same embedder. */
  embedderId?: string;
  /**
   * sha-256 of the source's uri, metadata and chunker id when indexed: a change to any of them re-indexes the source
   * even when its text (or mtime) is unchanged.
   */
  settingsHash?: string;
}

/** `VectorIndex.query`. */
export interface VectorQuery {
  vector: number[];
  k: number;
  filter?: MetadataFilter;
  /** Only chunks whose `embedderId` is this: vectors from another embedder live in another space and are never scored. */
  embedderId?: string;
}

/** Stores chunks with their vectors and finds the nearest ones. */
export interface VectorIndex {
  upsert(chunks: IndexedChunk[]): Promise<void>;
  remove(filter: { sourceId?: string; chunkIds?: string[] }): Promise<void>;
  /** The `k` chunks nearest `vector` by cosine similarity, score descending then chunkId ascending. */
  query(params: VectorQuery): Promise<{ chunkId: string; score: number }[]>;
  get(chunkId: string): Promise<IndexedChunk | undefined>;
  /** Every chunk (of one source when given), in a stable order: sourceId, then span start. */
  list(sourceId?: string): Promise<IndexedChunk[]>;
  /** Changes whenever the stored chunks change. */
  version(): Promise<string>;
}

/** A span of a source's text a chunker produced, with metadata of its own (e.g. `section`). */
export interface ChunkPiece extends ChunkSpan {
  metadata?: Record<string, MetadataValue>;
}

/** Splits a source's text into spans. */
export interface Chunker {
  (params: { text: string; uri: string }): ChunkPiece[];
  /**
   * Names the chunker and its settings (`createChunker` sets one). A source indexed under another id is re-chunked
   * even when its text and mtime are unchanged; a chunker without one is only noticed through changed text.
   */
  id?: string;
}

/** Something to index: inline text, or a file read through the knowledge base's `FsPolicy`. */
export interface KnowledgeSource {
  id: string;
  uri: string;
  text?: string;
  path?: string;
  metadata?: Record<string, MetadataValue>;
}

/** What `index` did. */
export interface IndexReport {
  /** Sources whose chunks were (re)written. */
  indexed: string[];
  /** Sources found unchanged (nothing embedded). */
  skipped: string[];
  /** Sources that could not be read, with why. */
  failed: { sourceId: string; code: string; message: string }[];
  /** Sources dropped by `prune`. */
  removed: string[];
  chunksWritten: number;
  chunksRemoved: number;
  /** Texts sent to the embedder. */
  embedded: number;
}

/** A search hit's provenance, for citing it (the same type `TaskResult.citations` holds). */
export type { Citation } from '../core/citations.js';

export type SearchMode = 'hybrid' | 'vector' | 'keyword';

/** One candidate a reranker sees and returns. */
export interface RerankCandidate {
  chunkId: string;
  text: string;
  score: number;
}

/** `KnowledgeBase.search`. */
export interface SearchRequest {
  query: string;
  /** Results wanted (default 5, at most 20). */
  k?: number;
  filter?: MetadataFilter;
  /** Default `hybrid`: reciprocal-rank fusion of vector and keyword (BM25) rankings. */
  mode?: SearchMode;
  /** Reorders (and may drop) the fused candidates before diversity is applied. */
  rerank?: (query: string, candidates: RerankCandidate[]) => Promise<RerankCandidate[]>;
  /** 0..1: with it, results are picked by maximal marginal relevance (1 = relevance only). */
  mmrLambda?: number;
  signal?: AbortSignal;
}

export interface SearchResult {
  chunkId: string;
  sourceId: string;
  uri: string;
  span: ChunkSpan;
  score: number;
  /** The part of the chunk most about the query, at most 400 characters. */
  snippet: string;
  citation: Citation;
}

/** `KnowledgeBase.read`: a chunk, and its neighbours in the same source. */
export interface ReadResult {
  chunk: IndexedChunk;
  prev?: string;
  next?: string;
}

/** `createKnowledgeBase(options)`. */
export interface KnowledgeBaseOptions {
  embedder: Embedder;
  index: VectorIndex;
  /** Default `createChunker()` (800 characters, 100 overlap, structural splits by file kind). */
  chunker?: Chunker;
  /** Needed for path sources: every file is checked by the policy for `read` and read through the access. */
  fs?: { access: FsAccess; policy: FsPolicy };
}

export interface KnowledgeBase {
  /** Indexes sources incrementally; `prune` also drops indexed sources not listed. */
  index(params: { sources: KnowledgeSource[]; prune?: boolean; signal?: AbortSignal }): Promise<IndexReport>;
  remove(params: { sourceIds: string[] }): Promise<void>;
  search(request: SearchRequest): Promise<SearchResult[]>;
  read(target: string | { sourceId: string; span: ChunkSpan }): Promise<ReadResult | undefined>;
  /**
   * Sources with chunks embedded by another embedder (or none recorded), sorted. Vector search skips those chunks;
   * `index` the sources again to re-embed them.
   */
  staleSources(): Promise<string[]>;
  /** A hash of every chunk id, content hash, uri and metadata, and the embedder id: it changes whenever results could. */
  version(): Promise<string>;
}
