import { byScoreThenId } from './vector-math.js';

/** The usual reciprocal-rank-fusion constant: damps the weight of the very top ranks. */
export const RRF_K = 60;

/** One ranked list's entry. */
export interface Ranked {
  chunkId: string;
  score: number;
}

/**
 * Reciprocal-rank fusion: each chunk scores the sum of `1 / (RRF_K + rank)` over the lists it appears in (rank from 1),
 * so a chunk ranked well by both vector and keyword search beats one ranked first by only one. Deterministic order.
 */
export function fuseRankings(lists: Ranked[][]): Ranked[] {
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.forEach(({ chunkId }, index) => fused.set(chunkId, (fused.get(chunkId) ?? 0) + 1 / (RRF_K + index + 1)));
  }
  return [...fused].map(([chunkId, score]) => ({ chunkId, score })).sort(byScoreThenId);
}
