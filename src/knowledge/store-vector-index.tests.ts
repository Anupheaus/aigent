import { describe, expect, it } from 'vitest';
import { isAigentError } from '../core/aigent-error.js';
import { tempRoot } from '../security/temp-dir.test-support.js';
import { createFileStore } from '../store/file-store.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createMongoFake } from '../store/mongo-fake.test-support.js';
import { createMongoStore } from '../store/mongo-store.js';
import type { Store } from '../store/store-types.js';
import type { IndexedChunk } from './knowledge-types.js';
import { STORE_VECTOR_COLLECTION, createStoreVectorIndex } from './store-vector-index.js';
import { FIXTURE_CHUNKS, behavesAsAnIndex, fixtureChunk } from './vector-index-behaviour.test-support.js';

/** The plan's page size: at most this many chunks per stored record. */
const PAGE_SIZE = 200;
const NAMESPACE = 'docs';

/** `count` chunks of one source, in span order, each with its own two-number vector. */
function manyChunks(count: number): IndexedChunk[] {
  return Array.from({ length: count }, (_unused, position) => fixtureChunk({ id: `m${String(position).padStart(4, '0')}`, sourceId: 'big', start: position * 10, vector: [1, position] }));
}

/** The store, recording the key of every compare-and-set that succeeded. */
function recording(store: Store): { store: Store; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    store: {
      ...store,
      compareAndSet: async params => {
        const written = await store.compareAndSet(params);
        if (written) writes.push(params.key);
        return written;
      },
    },
  };
}

interface StoredPage {
  chunks?: IndexedChunk[];
}

async function storedPages(store: Store): Promise<{ key: string; value: StoredPage }[]> {
  return (await store.list<StoredPage>(STORE_VECTOR_COLLECTION)).filter(({ value }) => Array.isArray(value.chunks));
}

describe('createStoreVectorIndex on the in-memory store', () => {
  behavesAsAnIndex(() => createStoreVectorIndex(createInMemoryStore(), NAMESPACE));
});

describe('createStoreVectorIndex on the mongo store (fake driver)', () => {
  behavesAsAnIndex(() => createStoreVectorIndex(createMongoStore({ db: createMongoFake().db }), NAMESPACE));
});

describe('createStoreVectorIndex', () => {
  it('reloads exactly what was written, in a new instance over a file store', async () => {
    const { root, cleanup } = await tempRoot();
    try {
      const written = createStoreVectorIndex(createFileStore({ dir: root }), NAMESPACE);
      await written.upsert(FIXTURE_CHUNKS);
      const reloaded = createStoreVectorIndex(createFileStore({ dir: root }), NAMESPACE);
      expect(await reloaded.list()).toEqual(await written.list());
      expect(await reloaded.version()).toBe(await written.version());
      expect(await reloaded.query({ vector: [1, 0], k: 2 })).toEqual(await written.query({ vector: [1, 0], k: 2 }));
    } finally {
      await cleanup();
    }
  });

  it(`stores at most ${PAGE_SIZE} chunks per record and rewrites only the pages that changed`, async () => {
    const { store, writes } = recording(createInMemoryStore());
    const index = createStoreVectorIndex(store, NAMESPACE);
    const chunks = manyChunks(450);
    await index.upsert(chunks);
    const pages = await storedPages(store);
    expect(pages.map(({ value }) => value.chunks?.length).sort()).toEqual([200, 200, 50]);
    const last = chunks[449];
    if (last == null) throw new Error('fixture has 450 chunks');
    writes.length = 0;
    await index.upsert([{ ...last, text: 'changed' }]);
    // One new page plus the index record that points at it; the two full pages are reused as they are.
    expect(writes).toHaveLength(2);
    expect((await index.get(last.chunkId))?.text).toBe('changed');
    expect(await index.list()).toHaveLength(450);
  });

  it('deletes the pages a change replaced, so no old vector stays behind', async () => {
    const store = createInMemoryStore();
    const index = createStoreVectorIndex(store, NAMESPACE);
    await index.upsert(FIXTURE_CHUNKS);
    await index.remove({ sourceId: 'a' });
    await index.remove({ sourceId: 'b' });
    expect(await storedPages(store)).toEqual([]);
    expect(JSON.stringify(await store.list(STORE_VECTOR_COLLECTION))).not.toContain('c1');
  });

  it('empties replaced pages on a store without delete', async () => {
    const { delete: _delete, ...withoutDelete } = createInMemoryStore();
    const index = createStoreVectorIndex(withoutDelete, NAMESPACE);
    await index.upsert(FIXTURE_CHUNKS);
    await index.remove({ chunkIds: ['c1', 'c2', 'c3', 'c4'] });
    const remaining = (await storedPages(withoutDelete)).flatMap(({ value }) => value.chunks ?? []);
    expect(remaining).toEqual([]);
    expect(await index.list()).toEqual([]);
  });

  it('sees another instance\'s changes on its next read', async () => {
    const store = createInMemoryStore();
    const first = createStoreVectorIndex(store, NAMESPACE);
    const second = createStoreVectorIndex(store, NAMESPACE);
    await first.upsert(FIXTURE_CHUNKS.slice(0, 2));
    expect(await second.list()).toHaveLength(2);
    await second.remove({ chunkIds: ['c3'] });
    expect((await first.list()).map(({ chunkId }) => chunkId)).toEqual(['c1']);
    expect(await first.version()).toBe(await second.version());
  });

  it('loses no change when instances write at the same time', async () => {
    const store = createInMemoryStore();
    const writers = Array.from({ length: 8 }, () => createStoreVectorIndex(store, NAMESPACE));
    await Promise.all(writers.map((writer, position) => writer.upsert([fixtureChunk({ id: `w${position}`, sourceId: 'w', start: position, vector: [1, position] })])));
    expect((await createStoreVectorIndex(store, NAMESPACE).list()).map(({ chunkId }) => chunkId)).toEqual(['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']);
  });

  it('keeps namespaces apart in one store', async () => {
    const store = createInMemoryStore();
    await createStoreVectorIndex(store, 'tenant-a').upsert(FIXTURE_CHUNKS);
    const other = createStoreVectorIndex(store, 'tenant-a:page');
    expect(await other.list()).toEqual([]);
    expect(await other.query({ vector: [1, 0], k: 5 })).toEqual([]);
  });

  it('leaves the index as it was when the store fails a write', async () => {
    const store = createInMemoryStore();
    const index = createStoreVectorIndex(store, NAMESPACE);
    await index.upsert(FIXTURE_CHUNKS.slice(0, 2));
    const before = await index.list();
    const failing: Store = { ...store, compareAndSet: async () => { throw new Error('disk full'); } };
    const broken = createStoreVectorIndex(failing, NAMESPACE);
    await expect(broken.upsert(FIXTURE_CHUNKS.slice(2))).rejects.toThrow('disk full');
    expect(await broken.list()).toEqual(before);
    expect(await createStoreVectorIndex(store, NAMESPACE).list()).toEqual(before);
  });

  it('refuses an index record of another schema version with store_failed, naming the record', async () => {
    const store = createInMemoryStore();
    await createStoreVectorIndex(store, NAMESPACE).upsert(FIXTURE_CHUNKS);
    const [manifest] = (await store.list<Record<string, unknown>>(STORE_VECTOR_COLLECTION)).filter(({ value }) => Array.isArray(value.pages));
    if (manifest == null) throw new Error('an index record exists');
    await store.compareAndSet({ collection: STORE_VECTOR_COLLECTION, key: manifest.key, expectedVersion: manifest.version, value: { ...manifest.value, schemaVersion: 99 } });
    const failure = await createStoreVectorIndex(store, NAMESPACE).list().then(() => undefined, (error: unknown) => error);
    expect(isAigentError(failure) && failure.code).toBe('store_failed');
    expect((failure as Error).message).toContain(manifest.key);
    expect((failure as Error).message).toContain('99');
  });

  it('refuses an empty namespace', () => {
    expect(() => createStoreVectorIndex(createInMemoryStore(), '')).toThrow(/namespace/);
  });
});
