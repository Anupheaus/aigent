import { createAigentError } from '../core/aigent-error.js';
import type { Store } from '../store/store-types.js';
import type { IndexedChunk, VectorIndex } from './knowledge-types.js';
import { STORE_VECTOR_COLLECTION, STORE_VECTOR_SCHEMA_VERSION, discardPages, manifestKey, newPageKey, placePages, readManifest, readPage } from './store-vector-pages.js';
import type { StoredVectorManifest, StoredVectorPage } from './store-vector-pages.js';
import { byPlace, matchesMetadata, versionOf } from './vector-index.js';
import { byScoreThenId, cosine } from './vector-math.js';

export { STORE_VECTOR_COLLECTION } from './store-vector-pages.js';

/** Re-reads when a page vanished between reading the index record and the page (another writer replaced it). */
const MAX_READ_ATTEMPTS = 10;
/** Like `updateRecord`: each lost compare-and-set means another writer's change landed, so N writers need at most N tries each. */
const MAX_WRITE_ATTEMPTS = 50;
/** Ceiling of the random wait after a lost compare-and-set. */
const MAX_BACKOFF_MS = 20;

/** What one instance last read: the index record's version and pages, and the chunks they hold. */
interface IndexState {
  version: number | undefined;
  pageKeys: string[];
  pages: IndexedChunk[][];
  chunks: Map<string, IndexedChunk>;
}

const EMPTY_STATE: IndexState = { version: undefined, pageKeys: [], pages: [], chunks: new Map() };

function backoff(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.random() * MAX_BACKOFF_MS));
}

function conflict(params: { namespace: string; action: string; attempts: number }): Error {
  const { namespace, action, attempts } = params;
  return createAigentError({
    code: 'store_conflict',
    message: `Could not ${action} vector index '${namespace}' after ${attempts} attempts because of concurrent writes; retry later`,
    details: { collection: STORE_VECTOR_COLLECTION, namespace, attempts },
  });
}

/**
 * A `VectorIndex` kept in any `Store` (collection `vector-index`), so it survives restarts and can be shared by
 * processes on the same store. Chunks are stored in page records of at most 200, each chunk staying on its page; an index record per
 * namespace lists the pages and changes only by compare-and-set, so concurrent writers never lose each other's
 * changes. A change writes new records only for the pages whose chunks changed (new chunks fill the last page, then
 * new ones) and then deletes the pages it replaced (empties them
 * on a store without `delete`). Every operation re-reads the index record and only the pages it has not seen.
 * Queries are exact cosine over every chunk of the namespace, held in memory: sized for thousands of chunks, not millions.
 */
export function createStoreVectorIndex(store: Store, namespace: string): VectorIndex {
  if (namespace === '') throw createAigentError({ code: 'invalid_input', message: 'createStoreVectorIndex needs a non-empty namespace (it keeps one index apart from another in the store)' });
  let cached = EMPTY_STATE;
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<IndexState> {
    for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
      const manifest = await readManifest({ store, namespace });
      if (manifest == null) return EMPTY_STATE;
      const { version, value: { pages: pageKeys } } = manifest;
      if (cached.version === version && cached.pageKeys.join('\n') === pageKeys.join('\n')) return cached;
      const known = new Map(cached.pageKeys.map((key, position) => [key, cached.pages[position]]));
      const pages: IndexedChunk[][] = [];
      for (const key of pageKeys) {
        const page = known.get(key) ?? await readPage({ store, key });
        if (page == null) break;
        pages.push(page);
      }
      if (pages.length !== pageKeys.length) {
        // Another writer replaced a page since the index record was read; give it a moment to settle.
        await backoff();
        continue;
      }
      cached = { version, pageKeys, pages, chunks: new Map(pages.flat().map(chunk => [chunk.chunkId, chunk])) };
      return cached;
    }
    throw conflict({ namespace, action: 'read', attempts: MAX_READ_ATTEMPTS });
  }

  /** Writes the pages of `next` that differ from `state`, then swaps the index record; false when another writer won. */
  async function commit(params: { state: IndexState; next: Map<string, IndexedChunk> }): Promise<boolean> {
    const { state, next } = params;
    const planned = placePages({ previous: state.pages, next });
    const pageKeys = planned.map(({ unchangedFrom }) => (unchangedFrom == null ? undefined : state.pageKeys[unchangedFrom]));
    if (planned.length === state.pages.length && pageKeys.every(key => key != null)) return true;
    const written: string[] = [];
    try {
      for (const [position, { chunks: page }] of planned.entries()) {
        if (pageKeys[position] != null) continue;
        const key = newPageKey(namespace);
        const value: StoredVectorPage = { schemaVersion: STORE_VECTOR_SCHEMA_VERSION, namespace, chunks: page };
        // A fresh random key: the create can only fail if the store misbehaves.
        if (!(await store.compareAndSet({ collection: STORE_VECTOR_COLLECTION, key, expectedVersion: undefined, value }))) throw conflict({ namespace, action: 'write a page of', attempts: 1 });
        written.push(key);
        pageKeys[position] = key;
      }
      const manifest: StoredVectorManifest = { schemaVersion: STORE_VECTOR_SCHEMA_VERSION, namespace, pages: pageKeys as string[] };
      if (!(await store.compareAndSet({ collection: STORE_VECTOR_COLLECTION, key: manifestKey(namespace), expectedVersion: state.version, value: manifest }))) {
        await discardPages({ store, namespace, keys: written }).catch(() => undefined);
        return false;
      }
    } catch (error) {
      await discardPages({ store, namespace, keys: written }).catch(() => undefined);
      throw error;
    }
    const replaced = state.pageKeys.filter(key => !pageKeys.includes(key));
    // The change is committed; a replaced page that could not be dropped is unreachable garbage, not an error of the change.
    await discardPages({ store, namespace, keys: replaced }).catch(() => undefined);
    return true;
  }

  function change(apply: (draft: Map<string, IndexedChunk>) => void): Promise<void> {
    const next = queue.then(async () => {
      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
        const state = await load();
        const draft = new Map(state.chunks);
        apply(draft);
        if (await commit({ state, next: draft })) return;
        await backoff();
      }
      throw conflict({ namespace, action: 'change', attempts: MAX_WRITE_ATTEMPTS });
    });
    queue = next.catch(() => undefined);
    return next;
  }

  async function current(): Promise<Map<string, IndexedChunk>> {
    await queue;
    return (await load()).chunks;
  }

  return {
    upsert: async upserted => change(draft => {
      for (const chunk of upserted) draft.set(chunk.chunkId, structuredClone(chunk));
    }),
    remove: async ({ sourceId, chunkIds }) => change(draft => {
      for (const id of chunkIds ?? []) draft.delete(id);
      if (sourceId != null) for (const [id, chunk] of draft) if (chunk.sourceId === sourceId) draft.delete(id);
    }),
    query: async ({ vector, k, filter, embedderId }) => [...(await current()).values()]
      .filter(chunk => chunk.vector != null && (embedderId == null || chunk.embedderId === embedderId) && matchesMetadata({ chunk, ...(filter == null ? {} : { filter }) }))
      .map(chunk => ({ chunkId: chunk.chunkId, score: cosine(vector, chunk.vector ?? []) }))
      .sort(byScoreThenId)
      .slice(0, k),
    get: async chunkId => {
      const chunk = (await current()).get(chunkId);
      return chunk == null ? undefined : structuredClone(chunk);
    },
    list: async sourceId => [...(await current()).values()]
      .filter(chunk => sourceId == null || chunk.sourceId === sourceId)
      .sort(byPlace)
      .map(chunk => structuredClone(chunk)),
    version: async () => versionOf((await current()).values()),
  };
}
