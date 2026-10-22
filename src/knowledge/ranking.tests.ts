import { describe, expect, it } from 'vitest';
import { createBm25 } from './bm25.js';
import { fuseRankings, RRF_K } from './hybrid-search.js';
import { collapseNearDuplicates, mmrSelect, shingleJaccard } from './mmr.js';
import { tokenize } from './tokenize.js';
import { cosine, normalise } from './vector-math.js';

describe('tokenize', () => {
  it('lower-cases words and adds the parts of identifiers', () => {
    expect(tokenize('Call parseConfigFile(MAX_RETRY) now')).toEqual(['call', 'parseconfigfile', 'parse', 'config', 'file', 'max_retry', 'max', 'retry', 'now']);
    expect(tokenize('HTTPServer v2')).toEqual(['httpserver', 'http', 'server', 'v2']);
  });
});

describe('createBm25', () => {
  it('matches hand-computed Okapi BM25 scores', () => {
    const index = createBm25([{ id: 'd1', text: 'apple banana' }, { id: 'd2', text: 'apple apple cherry' }, { id: 'd3', text: 'cherry' }]);
    // idf(apple) = ln(1 + (3 - 2 + 0.5) / (2 + 0.5)) = ln 1.6; average length 2.
    const idf = Math.log(1.6);
    const [first, second, ...rest] = index.search({ query: 'apple', k: 10 });
    expect(first?.id).toBe('d2');
    expect(first?.score).toBeCloseTo((idf * 2 * 2.2) / (2 + 1.2 * (0.25 + 0.75 * 1.5)), 10);
    expect(second?.id).toBe('d1');
    expect(second?.score).toBeCloseTo(idf, 10);
    expect(rest).toEqual([]);
  });

  it('breaks ties by id and limits to k', () => {
    const index = createBm25([{ id: 'b', text: 'same words' }, { id: 'a', text: 'same words' }, { id: 'c', text: 'same words' }]);
    expect(index.search({ query: 'same', k: 2 }).map(({ id }) => id)).toEqual(['a', 'b']);
  });
});

describe('vector math', () => {
  it('computes cosine similarity and normalises', () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(normalise([3, 4])).toEqual([0.6, 0.8]);
  });
});

describe('fuseRankings', () => {
  it('sums reciprocal ranks across lists, ties by chunk id', () => {
    const fused = fuseRankings([[{ chunkId: 'a', score: 9 }, { chunkId: 'b', score: 5 }], [{ chunkId: 'b', score: 3 }, { chunkId: 'c', score: 1 }]]);
    expect(fused.map(({ chunkId }) => chunkId)).toEqual(['b', 'a', 'c']);
    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 12);
    expect(fuseRankings([[{ chunkId: 'z', score: 1 }], [{ chunkId: 'y', score: 1 }]]).map(({ chunkId }) => chunkId)).toEqual(['y', 'z']);
  });
});

describe('diversity', () => {
  const text = 'the quick brown fox jumps over the lazy dog near the river bank today';
  it('collapses near duplicates, keeping the better-ranked one', () => {
    const candidates = [{ chunkId: 'a', score: 3, text }, { chunkId: 'b', score: 2, text: `${text}!` }, { chunkId: 'c', score: 1, text: 'completely different words about databases and indexes' }];
    expect(shingleJaccard(text, `${text}!`)).toBe(1);
    expect(collapseNearDuplicates(candidates).map(({ chunkId }) => chunkId)).toEqual(['a', 'c']);
  });

  it('prefers a diverse second pick with mmr, and pure relevance with lambda 1', () => {
    const candidates = [
      { chunkId: 'a', score: 1, text: 'x', vector: [1, 0] },
      { chunkId: 'b', score: 0.95, text: 'y', vector: [0.99, 0.1] },
      { chunkId: 'c', score: 0.6, text: 'z', vector: [0, 1] },
    ];
    expect(mmrSelect({ candidates, k: 2, lambda: 0.5 }).map(({ chunkId }) => chunkId)).toEqual(['a', 'c']);
    expect(mmrSelect({ candidates, k: 2, lambda: 1 }).map(({ chunkId }) => chunkId)).toEqual(['a', 'b']);
  });
});
