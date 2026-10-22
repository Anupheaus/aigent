import { createHash } from 'node:crypto';
import { canonicalJson } from '../core/canonical-json.js';
import type { IndexedChunk, MetadataFilter } from './knowledge-types.js';

export type { VectorIndex } from './knowledge-types.js';

/** Hex sha-256 of a text. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Whether a chunk passes a metadata filter (`sourceId` and `uri` match the chunk's own fields). */
export function matchesMetadata(params: { chunk: IndexedChunk; filter?: MetadataFilter }): boolean {
  const { chunk, filter } = params;
  if (filter == null) return true;
  return Object.entries(filter).every(([key, value]) => {
    if (key === 'sourceId') return chunk.sourceId === value;
    if (key === 'uri') return chunk.uri === value;
    return Object.hasOwn(chunk.metadata, key) && chunk.metadata[key] === value;
  });
}

/** Stable chunk order: sourceId, then span start, then chunkId. */
export function byPlace(left: IndexedChunk, right: IndexedChunk): number {
  if (left.sourceId !== right.sourceId) return left.sourceId < right.sourceId ? -1 : 1;
  if (left.span.start !== right.span.start) return left.span.start - right.span.start;
  if (left.chunkId === right.chunkId) return 0;
  return left.chunkId < right.chunkId ? -1 : 1;
}

/**
 * A hash of every chunk's id, content hash, uri and metadata: equal sets of chunks give equal versions, and a chunk
 * moved to another uri or tagged differently (which changes search results and citations) gives a new one.
 */
export function versionOf(chunks: Iterable<IndexedChunk>): string {
  return sha256([...chunks].map(({ chunkId, contentHash, uri, metadata }) => canonicalJson([chunkId, contentHash, uri, metadata])).sort().join('\n'));
}
