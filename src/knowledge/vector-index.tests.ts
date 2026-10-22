import { describe, expect, it } from 'vitest';
import { createMemoryFsAccess } from '../security/fs-access-memory.js';
import type { FsAccess } from '../security/fs-access.js';
import { createFileVectorIndex } from './file-vector-index.js';
import type { IndexedChunk, VectorIndex } from './knowledge-types.js';
import { createMemoryVectorIndex } from './memory-vector-index.js';

function chunk(params: { id: string; sourceId: string; start: number; vector: number[]; lang?: string }): IndexedChunk {
  const { id, sourceId, start, vector, lang = 'en' } = params;
  return { chunkId: id, sourceId, uri: `mem://${sourceId}`, span: { start, end: start + 5 }, text: `text ${id}`, metadata: { lang }, vector, contentHash: `h-${id}` };
}

const CHUNKS = [
  chunk({ id: 'c3', sourceId: 'b', start: 0, vector: [0, 1] }),
  chunk({ id: 'c1', sourceId: 'a', start: 10, vector: [1, 0] }),
  chunk({ id: 'c2', sourceId: 'a', start: 0, vector: [1, 1], lang: 'fr' }),
  chunk({ id: 'c4', sourceId: 'b', start: 9, vector: [1, 0] }),
];

function behavesAsAnIndex(make: () => VectorIndex): void {
  it('queries by cosine similarity (ties by chunk id), with metadata filters', async () => {
    const index = make();
    await index.upsert(CHUNKS);
    expect(await index.query({ vector: [1, 0], k: 3 })).toEqual([{ chunkId: 'c1', score: 1 }, { chunkId: 'c4', score: 1 }, { chunkId: 'c2', score: expect.closeTo(Math.SQRT1_2, 10) }]);
    expect((await index.query({ vector: [1, 0], k: 5, filter: { lang: 'fr' } })).map(({ chunkId }) => chunkId)).toEqual(['c2']);
    expect((await index.query({ vector: [1, 0], k: 5, filter: { sourceId: 'b' } })).map(({ chunkId }) => chunkId)).toEqual(['c4', 'c3']);
  });

  it('lists in source and span order, gets copies, removes by source or id, and versions the content', async () => {
    const index = make();
    const empty = await index.version();
    await index.upsert(CHUNKS);
    const full = await index.version();
    expect(full).not.toBe(empty);
    expect((await index.list()).map(({ chunkId }) => chunkId)).toEqual(['c2', 'c1', 'c3', 'c4']);
    expect((await index.list('b')).map(({ chunkId }) => chunkId)).toEqual(['c3', 'c4']);
    const got = await index.get('c1');
    if (got != null) got.text = 'changed';
    expect((await index.get('c1'))?.text).toBe('text c1');
    await index.remove({ sourceId: 'a' });
    await index.remove({ chunkIds: ['c3'] });
    expect((await index.list()).map(({ chunkId }) => chunkId)).toEqual(['c4']);
    await index.upsert(CHUNKS);
    expect(await index.version()).toBe(full);
  });

  it('queries only the chunks of the named embedder (review I3)', async () => {
    const index = make();
    await index.upsert(CHUNKS.map((indexed, position) => ({ ...indexed, embedderId: position % 2 === 0 ? 'new' : 'old' })));
    expect((await index.query({ vector: [1, 0], k: 5, embedderId: 'new' })).map(({ chunkId }) => chunkId)).toEqual(['c2', 'c3']);
  });

  it('versions uri and metadata too: the same text moved to another tenant or uri is a change (review I2)', async () => {
    const index = make();
    await index.upsert(CHUNKS);
    const before = await index.version();
    const [first] = CHUNKS;
    if (first == null) throw new Error('fixture has chunks');
    await index.upsert([{ ...first, metadata: { lang: 'de' } }]);
    const retagged = await index.version();
    expect(retagged).not.toBe(before);
    await index.upsert([{ ...first, metadata: { lang: 'de' }, uri: 'mem://moved' }]);
    expect(await index.version()).not.toBe(retagged);
  });
}

describe('createMemoryVectorIndex', () => {
  behavesAsAnIndex(() => createMemoryVectorIndex());
});

describe('createFileVectorIndex', () => {
  const PATH = '/data/index.jsonl';
  const disk = (): FsAccess => createMemoryFsAccess({ platform: 'posix', files: { '/data': { dir: true } } });
  behavesAsAnIndex(() => createFileVectorIndex({ path: PATH, access: disk() }));

  it('reloads exactly what was written', async () => {
    const access = disk();
    const written = createFileVectorIndex({ path: PATH, access });
    await written.upsert(CHUNKS);
    const reloaded = createFileVectorIndex({ path: PATH, access });
    expect(await reloaded.list()).toEqual(await written.list());
    expect(await reloaded.version()).toBe(await written.version());
  });

  it('keeps the previous state readable when a write crashes, on disk and in memory', async () => {
    const access = disk();
    const index = createFileVectorIndex({ path: PATH, access });
    await index.upsert(CHUNKS.slice(0, 2));
    const before = await index.list();
    for (const crash of ['writeFile', 'rename'] as const) {
      const crashing: FsAccess = { ...access, [crash]: async () => { throw new Error(`disk failed during ${crash}`); } };
      const failing = createFileVectorIndex({ path: PATH, access: crashing });
      await expect(failing.upsert(CHUNKS.slice(2))).rejects.toThrow(crash);
      expect(await failing.list()).toEqual(before);
      expect(await createFileVectorIndex({ path: PATH, access }).list()).toEqual(before);
    }
  });

  it('refuses a corrupt file with the line number', async () => {
    const access = createMemoryFsAccess({ platform: 'posix', files: { [PATH]: '{"chunkId":"x"}\nnot json\n' } });
    await expect(createFileVectorIndex({ path: PATH, access }).list()).rejects.toThrow(/line 2/);
  });
});
