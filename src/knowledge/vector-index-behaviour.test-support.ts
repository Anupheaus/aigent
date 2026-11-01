import { expect, it } from 'vitest';
import type { IndexedChunk, VectorIndex } from './knowledge-types.js';

/** A chunk with fixture defaults: uri from the source, a five-character span, and `lang` metadata. */
export function fixtureChunk(params: { id: string; sourceId: string; start: number; vector: number[]; lang?: string }): IndexedChunk {
  const { id, sourceId, start, vector, lang = 'en' } = params;
  return { chunkId: id, sourceId, uri: `mem://${sourceId}`, span: { start, end: start + 5 }, text: `text ${id}`, metadata: { lang }, vector, contentHash: `h-${id}` };
}

/** Four chunks of two sources, deliberately out of order, with known cosine scores against `[1, 0]`. */
export const FIXTURE_CHUNKS: IndexedChunk[] = [
  fixtureChunk({ id: 'c3', sourceId: 'b', start: 0, vector: [0, 1] }),
  fixtureChunk({ id: 'c1', sourceId: 'a', start: 10, vector: [1, 0] }),
  fixtureChunk({ id: 'c2', sourceId: 'a', start: 0, vector: [1, 1], lang: 'fr' }),
  fixtureChunk({ id: 'c4', sourceId: 'b', start: 9, vector: [1, 0] }),
];

/** Registers the tests every `VectorIndex` must pass; `make` builds a fresh, empty index for each. */
export function behavesAsAnIndex(make: () => VectorIndex): void {
  it('queries by cosine similarity (ties by chunk id), with metadata filters', async () => {
    const index = make();
    await index.upsert(FIXTURE_CHUNKS);
    expect(await index.query({ vector: [1, 0], k: 3 })).toEqual([{ chunkId: 'c1', score: 1 }, { chunkId: 'c4', score: 1 }, { chunkId: 'c2', score: expect.closeTo(Math.SQRT1_2, 10) }]);
    expect((await index.query({ vector: [1, 0], k: 5, filter: { lang: 'fr' } })).map(({ chunkId }) => chunkId)).toEqual(['c2']);
    expect((await index.query({ vector: [1, 0], k: 5, filter: { sourceId: 'b' } })).map(({ chunkId }) => chunkId)).toEqual(['c4', 'c3']);
  });

  it('lists in source and span order, gets copies, removes by source or id, and versions the content', async () => {
    const index = make();
    const empty = await index.version();
    await index.upsert(FIXTURE_CHUNKS);
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
    await index.upsert(FIXTURE_CHUNKS);
    expect(await index.version()).toBe(full);
  });

  it('queries only the chunks of the named embedder (review I3)', async () => {
    const index = make();
    await index.upsert(FIXTURE_CHUNKS.map((indexed, position) => ({ ...indexed, embedderId: position % 2 === 0 ? 'new' : 'old' })));
    expect((await index.query({ vector: [1, 0], k: 5, embedderId: 'new' })).map(({ chunkId }) => chunkId)).toEqual(['c2', 'c3']);
  });

  it('versions uri and metadata too: the same text moved to another tenant or uri is a change (review I2)', async () => {
    const index = make();
    await index.upsert(FIXTURE_CHUNKS);
    const before = await index.version();
    const [first] = FIXTURE_CHUNKS;
    if (first == null) throw new Error('fixture has chunks');
    await index.upsert([{ ...first, metadata: { lang: 'de' } }]);
    const retagged = await index.version();
    expect(retagged).not.toBe(before);
    await index.upsert([{ ...first, metadata: { lang: 'de' }, uri: 'mem://moved' }]);
    expect(await index.version()).not.toBe(retagged);
  });
}
