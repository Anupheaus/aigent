import type { IndexedChunk, VectorIndex } from './knowledge-types.js';
import { byScoreThenId, cosine } from './vector-math.js';
import { byPlace, matchesMetadata, versionOf } from './vector-index.js';

/** The chunk map a vector index works on, and how a change is made durable. */
export interface ChunkStoreOptions {
  /** Loads the initial chunks (once, before the first operation). */
  load(): Promise<IndexedChunk[]>;
  /** Makes the whole new state durable; when it throws the change is undone and the error passed on. */
  persist?(chunks: IndexedChunk[]): Promise<void>;
}

/** A `VectorIndex` over a chunk map; changes are serialised, so a persist never races another change. */
export function createChunkStoreIndex(options: ChunkStoreOptions): VectorIndex {
  const { load, persist } = options;
  let chunks: Promise<Map<string, IndexedChunk>> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const current = (): Promise<Map<string, IndexedChunk>> => (chunks ??= load().then(loaded => new Map(loaded.map(chunk => [chunk.chunkId, chunk]))));
  const change = (apply: (draft: Map<string, IndexedChunk>) => void): Promise<void> => {
    const next = queue.then(async () => {
      const map = await current();
      const draft = new Map(map);
      apply(draft);
      await persist?.([...draft.values()].sort(byPlace));
      // Only a durable change replaces the state.
      chunks = Promise.resolve(draft);
    });
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    upsert: async upserted => change(draft => {
      for (const chunk of upserted) draft.set(chunk.chunkId, structuredClone(chunk));
    }),
    remove: async ({ sourceId, chunkIds }) => change(draft => {
      for (const id of chunkIds ?? []) draft.delete(id);
      if (sourceId != null) for (const [id, chunk] of draft) if (chunk.sourceId === sourceId) draft.delete(id);
    }),
    query: async ({ vector, k, filter }) => {
      await queue;
      const map = await current();
      return [...map.values()]
        .filter(chunk => chunk.vector != null && matchesMetadata({ chunk, ...(filter == null ? {} : { filter }) }))
        .map(chunk => ({ chunkId: chunk.chunkId, score: cosine(vector, chunk.vector ?? []) }))
        .sort(byScoreThenId)
        .slice(0, k);
    },
    get: async chunkId => {
      await queue;
      const chunk = (await current()).get(chunkId);
      return chunk == null ? undefined : structuredClone(chunk);
    },
    list: async sourceId => {
      await queue;
      return [...(await current()).values()].filter(chunk => sourceId == null || chunk.sourceId === sourceId).sort(byPlace).map(chunk => structuredClone(chunk));
    },
    version: async () => {
      await queue;
      return versionOf((await current()).values());
    },
  };
}

/** A `VectorIndex` held in memory (exact cosine search over every chunk). */
export function createMemoryVectorIndex(): VectorIndex {
  return createChunkStoreIndex({ load: async () => [] });
}
