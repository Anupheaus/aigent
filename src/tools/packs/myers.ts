import { anchorPairs } from './patience-anchors.js';

/** One step of a line diff. */
export type DiffOp = { kind: 'equal' | 'delete' | 'insert'; line: string };

/**
 * Deepest edit distance searched for a shortest script. The frontiers kept for the backtrack hold (D+1)^2 numbers in
 * total, so this bounds memory at about 9 MB whatever the input size.
 */
export const MAX_EDIT_DISTANCE = 1_500;
/** Diagonal steps and line comparisons spent on one diff before settling for a non-minimal script (bounds time). */
const MAX_DIFF_WORK = 25_000_000;

/** A line diff and whether it is a shortest edit script (false when the bounds forced a fallback). */
export interface LineDiff {
  ops: DiffOp[];
  isMinimal: boolean;
}

/** Work left for one diff, shared by every search it makes. */
interface WorkBudget {
  left: number;
}

/** Whether the frontier step at diagonal `diagonal` of depth `depth` came down (an insert) rather than right (a delete). */
function isDownStep(params: { previous: Int32Array; diagonal: number; depth: number }): boolean {
  const { previous, diagonal, depth } = params;
  if (diagonal === -depth) return true;
  if (diagonal === depth) return false;
  // `previous` covers diagonals -(depth-1)..depth-1 at index diagonal + depth - 1.
  return (previous[diagonal - 1 + depth - 1] ?? 0) < (previous[diagonal + 1 + depth - 1] ?? 0);
}

/** The frontier of every depth up to the end, or undefined once the distance bound or the budget is passed. */
function frontiers(params: { a: readonly string[]; b: readonly string[]; budget: WorkBudget }): Int32Array[] | undefined {
  const { a, b, budget } = params;
  const trace: Int32Array[] = [];
  const maxDepth = Math.min(a.length + b.length, MAX_EDIT_DISTANCE);
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    // Only the 2d+1 diagonals reachable at this depth are kept: memory grows with D², never with N·M.
    const current = new Int32Array(2 * depth + 1);
    const previous = trace[depth - 1] ?? new Int32Array(1);
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const isDown = depth > 0 && isDownStep({ previous, diagonal, depth });
      let x = depth === 0 ? 0 : isDown ? previous[diagonal + 1 + depth - 1] ?? 0 : (previous[diagonal - 1 + depth - 1] ?? 0) + 1;
      let y = x - diagonal;
      while (x < a.length && y < b.length && a[x] === b[y]) { x += 1; y += 1; budget.left -= 1; }
      current[diagonal + depth] = x;
      if (x >= a.length && y >= b.length) { trace.push(current); return trace; }
    }
    trace.push(current);
    budget.left -= 2 * depth + 1;
    if (budget.left < 0) return undefined;
  }
  return undefined;
}

/** Walks the recorded frontiers back from the end, emitting the script in order. */
function backtrack(params: { a: readonly string[]; b: readonly string[]; trace: Int32Array[] }): DiffOp[] {
  const { a, b, trace } = params;
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let depth = trace.length - 1; depth > 0; depth -= 1) {
    const previous = trace[depth - 1] ?? new Int32Array(1);
    const diagonal = x - y;
    const isDown = isDownStep({ previous, diagonal, depth });
    const previousDiagonal = isDown ? diagonal + 1 : diagonal - 1;
    const previousX = previous[previousDiagonal + depth - 1] ?? 0;
    const previousY = previousX - previousDiagonal;
    // The snake (equal lines) ran from just after the step to (x, y).
    const snakeStartX = isDown ? previousX : previousX + 1;
    while (x > snakeStartX) { x -= 1; y -= 1; ops.push({ kind: 'equal', line: a[x] ?? '' }); }
    ops.push(isDown ? { kind: 'insert', line: b[previousY] ?? '' } : { kind: 'delete', line: a[previousX] ?? '' });
    x = previousX;
    y = previousY;
  }
  while (x > 0) { x -= 1; ops.push({ kind: 'equal', line: a[x] ?? '' }); }
  return ops.reverse();
}

const equalOps = (lines: readonly string[]): DiffOp[] => lines.map(line => ({ kind: 'equal', line }));
const replaceOps = (params: { a: readonly string[]; b: readonly string[] }): DiffOp[] => [
  ...params.a.map((line): DiffOp => ({ kind: 'delete', line })),
  ...params.b.map((line): DiffOp => ({ kind: 'insert', line })),
];

/** A shortest script after trimming the common prefix and suffix, or undefined when the bounds are passed. */
function boundedShortest(params: { a: readonly string[]; b: readonly string[]; budget: WorkBudget }): DiffOp[] | undefined {
  const { a, b, budget } = params;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  budget.left -= prefix + suffix;
  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  // One empty side needs no search: its script is all inserts or all deletes, which is also the shortest.
  const trace = middleA.length === 0 || middleB.length === 0 ? [] : frontiers({ a: middleA, b: middleB, budget });
  if (trace == null) return undefined;
  const middle = trace.length === 0 ? replaceOps({ a: middleA, b: middleB }) : backtrack({ a: middleA, b: middleB, trace });
  return [...equalOps(a.slice(0, prefix)), ...middle, ...equalOps(a.slice(a.length - suffix))];
}

/** Lines unique to both sides anchor the texts (patience diff); each gap between anchors is diffed within the bounds. */
function anchoredDiff(params: { a: readonly string[]; b: readonly string[] }): DiffOp[] {
  const { a, b } = params;
  const budget: WorkBudget = { left: MAX_DIFF_WORK };
  const ops: DiffOp[] = [];
  let fromA = 0;
  let fromB = 0;
  for (const [anchorA, anchorB] of [...anchorPairs({ a, b }), [a.length, b.length] as const]) {
    const gap = { a: a.slice(fromA, anchorA), b: b.slice(fromB, anchorB) };
    for (const op of boundedShortest({ ...gap, budget }) ?? replaceOps(gap)) ops.push(op);
    if (anchorA < a.length) ops.push({ kind: 'equal', line: a[anchorA] ?? '' });
    fromA = anchorA + 1;
    fromB = anchorB + 1;
  }
  return ops;
}

/**
 * The shortest edit script from `a` to `b` (Myers' O((N+M)D) algorithm) after trimming the common prefix and suffix.
 * Memory is O(N+M+D²) and work is bounded: past `MAX_EDIT_DISTANCE` or the work budget, lines unique to both sides
 * anchor a patience diff whose gaps are diffed within the same bounds (or replaced whole). The result is always a
 * correct script; `isMinimal` says whether it is a shortest one.
 */
export function myersDiff(params: { a: readonly string[]; b: readonly string[] }): LineDiff {
  const shortest = boundedShortest({ ...params, budget: { left: MAX_DIFF_WORK } });
  return shortest != null ? { ops: shortest, isMinimal: true } : { ops: anchoredDiff(params), isMinimal: false };
}
