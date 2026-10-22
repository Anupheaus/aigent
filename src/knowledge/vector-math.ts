/** Cosine similarity of two vectors (0 when either is all zeros or their lengths differ). */
export function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const [index, value] of left.entries()) {
    const other = right[index] ?? 0;
    dot += value * other;
    leftNorm += value * value;
    rightNorm += other * other;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/** The vector scaled to length 1 (unchanged when all zeros). */
export function normalise(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return length === 0 ? vector : vector.map(value => value / length);
}

/** Scored ids, best first; equal scores by id ascending, so every ranking is deterministic. */
export function byScoreThenId<T extends { score: number; chunkId: string }>(left: T, right: T): number {
  if (right.score !== left.score) return right.score - left.score;
  if (left.chunkId === right.chunkId) return 0;
  return left.chunkId < right.chunkId ? -1 : 1;
}
