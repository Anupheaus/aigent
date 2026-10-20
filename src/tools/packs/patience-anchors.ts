/** Where a line occurs: how often on each side and (for lines that occur once) its index there. */
interface Occurrence {
  countA: number;
  countB: number;
  indexA: number;
  indexB: number;
}

/** The longest run of pairs whose `b` index increases (pairs arrive ordered by `a` index): patience sorting, O(n log n). */
function longestIncreasing(pairs: readonly (readonly [number, number])[]): [number, number][] {
  /** `tails[length - 1]`: the pair index ending the best run of that length found so far. */
  const tails: number[] = [];
  const previous = new Int32Array(pairs.length).fill(-1);
  for (const [index, [, indexB]] of pairs.entries()) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((pairs[tails[middle] ?? 0]?.[1] ?? 0) < indexB) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1] ?? -1;
    tails[low] = index;
  }
  const run: [number, number][] = [];
  for (let at = tails.at(-1) ?? -1; at !== -1; at = previous[at] ?? -1) {
    const [indexA = 0, indexB = 0] = pairs[at] ?? [];
    run.push([indexA, indexB]);
  }
  return run.reverse();
}

/**
 * Anchor points for a patience diff: lines that occur exactly once in `a` and once in `b`, kept where their order
 * agrees on both sides. Linear apart from the O(n log n) ordering step.
 */
export function anchorPairs(params: { a: readonly string[]; b: readonly string[] }): [number, number][] {
  const { a, b } = params;
  const occurrences = new Map<string, Occurrence>();
  for (const [indexA, line] of a.entries()) {
    const seen = occurrences.get(line) ?? { countA: 0, countB: 0, indexA, indexB: -1 };
    seen.countA += 1;
    occurrences.set(line, seen);
  }
  for (const [indexB, line] of b.entries()) {
    const seen = occurrences.get(line);
    if (seen == null) continue;
    seen.countB += 1;
    seen.indexB = indexB;
  }
  const pairs: [number, number][] = [];
  for (const [indexA, line] of a.entries()) {
    const seen = occurrences.get(line);
    if (seen?.countA === 1 && seen.countB === 1) pairs.push([indexA, seen.indexB]);
  }
  return longestIncreasing(pairs);
}
