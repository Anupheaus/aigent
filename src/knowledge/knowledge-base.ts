import { createAigentError } from '../core/aigent-error.js';
import { createChunker } from './chunker.js';
import { indexSources } from './index-sources.js';
import type { IndexDeps } from './index-sources.js';
import type { KnowledgeBase, KnowledgeBaseOptions, ReadResult } from './knowledge-types.js';
import { searchKnowledge } from './search-knowledge.js';
import type { SearchDeps } from './search-knowledge.js';
import { sha256 } from './vector-index.js';

function invalid(message: string): never {
  throw createAigentError({ code: 'invalid_definition', message: `createKnowledgeBase: ${message}` });
}

/**
 * A knowledge base: sources are chunked, embedded and stored in the index (incrementally: unchanged sources are
 * skipped and unchanged chunks keep their vectors), then searched with hybrid ranking and citations.
 */
export function createKnowledgeBase(options: KnowledgeBaseOptions): KnowledgeBase {
  const { embedder, index, chunker = createChunker(), fs } = options ?? {};
  if (typeof embedder?.embed !== 'function' || typeof embedder.id !== 'string') invalid('needs an embedder ({ id, dimensions, embed })');
  if (typeof index?.query !== 'function') invalid('needs a vector index (createMemoryVectorIndex or createFileVectorIndex)');
  const indexDeps: IndexDeps = { embedder, index, chunker, ...(fs == null ? {} : { fs }) };
  const searchDeps: SearchDeps = { embedder, index, keywordCache: {} };
  // Index changes run one at a time, so two calls for the same source never interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const serialised = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };
  const read = async (target: Parameters<KnowledgeBase['read']>[0]): Promise<ReadResult | undefined> => {
    const chunk = typeof target === 'string' ? await index.get(target) : undefined;
    const sourceId = typeof target === 'string' ? chunk?.sourceId : target.sourceId;
    if (sourceId == null) return undefined;
    const siblings = await index.list(sourceId);
    const position = typeof target === 'string'
      ? siblings.findIndex(({ chunkId }) => chunkId === target)
      : (() => {
        const exact = siblings.findIndex(({ span }) => span.start === target.span.start && span.end === target.span.end);
        return exact >= 0 ? exact : siblings.findIndex(({ span }) => span.start <= target.span.start && target.span.start < span.end);
      })();
    const found = siblings[position];
    if (found == null) return undefined;
    const prev = siblings[position - 1]?.chunkId;
    const next = siblings[position + 1]?.chunkId;
    return { chunk: found, ...(prev == null ? {} : { prev }), ...(next == null ? {} : { next }) };
  };
  return {
    index: request => serialised(() => indexSources({ deps: indexDeps, request })),
    remove: ({ sourceIds }) => serialised(async () => {
      for (const sourceId of sourceIds) await index.remove({ sourceId });
    }),
    search: async request => {
      await queue;
      return searchKnowledge({ deps: searchDeps, request });
    },
    read,
    version: async () => sha256(`${await index.version()}\n${embedder.id}`),
  };
}
