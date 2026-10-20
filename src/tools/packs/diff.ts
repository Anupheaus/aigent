/** One step of a line diff. */
export type DiffOp = { kind: 'equal' | 'delete' | 'insert'; line: string };

/** Lines past which the quadratic worst case is not attempted: the diff falls back to delete-all, insert-all. */
const MAX_DIFF_COST = 4_000_000;

/**
 * The shortest edit script from `a` to `b` (Myers' O((N+M)D) algorithm): equal, deleted and inserted lines in order.
 * Very large, very different inputs fall back to replacing everything, which is still a correct (if long) script.
 */
export function diffLines(params: { a: readonly string[]; b: readonly string[] }): DiffOp[] {
  const { a, b } = params;
  const total = a.length + b.length;
  if (a.length * b.length > MAX_DIFF_COST) return [...a.map(line => ({ kind: 'delete' as const, line })), ...b.map(line => ({ kind: 'insert' as const, line }))];
  const offset = total + 1;
  const furthest = new Array<number>(2 * total + 3).fill(0);
  const trace: number[][] = [];
  for (let depth = 0; depth <= total; depth += 1) {
    trace.push([...furthest]);
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const isDown = diagonal === -depth || (diagonal !== depth && (furthest[offset + diagonal - 1] ?? 0) < (furthest[offset + diagonal + 1] ?? 0));
      let x = isDown ? furthest[offset + diagonal + 1] ?? 0 : (furthest[offset + diagonal - 1] ?? 0) + 1;
      let y = x - diagonal;
      while (x < a.length && y < b.length && a[x] === b[y]) { x += 1; y += 1; }
      furthest[offset + diagonal] = x;
      if (x >= a.length && y >= b.length) return backtrack({ a, b, trace, offset });
    }
  }
  return [];
}

/** Walks the recorded frontiers back from the end, emitting the script in order. */
function backtrack(params: { a: readonly string[]; b: readonly string[]; trace: number[][]; offset: number }): DiffOp[] {
  const { a, b, trace, offset } = params;
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let depth = trace.length - 1; depth >= 0; depth -= 1) {
    const frontier = trace[depth] ?? [];
    const diagonal = x - y;
    const isDown = diagonal === -depth || (diagonal !== depth && (frontier[offset + diagonal - 1] ?? 0) < (frontier[offset + diagonal + 1] ?? 0));
    const previousDiagonal = isDown ? diagonal + 1 : diagonal - 1;
    const previousX = frontier[offset + previousDiagonal] ?? 0;
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) { x -= 1; y -= 1; ops.push({ kind: 'equal', line: a[x] ?? '' }); }
    if (depth > 0) {
      if (isDown) { y -= 1; ops.push({ kind: 'insert', line: b[y] ?? '' }); } else { x -= 1; ops.push({ kind: 'delete', line: a[x] ?? '' }); }
    }
  }
  return ops.reverse();
}

/** Rebuilds `b` from `a` and the script (used to prove a diff correct). */
export function applyDiff(params: { a: readonly string[]; ops: readonly DiffOp[] }): string[] {
  const { a, ops } = params;
  const result: string[] = [];
  let index = 0;
  for (const { kind, line } of ops) {
    if (kind === 'insert') { result.push(line); continue; }
    if (a[index] !== line) throw new Error(`diff does not apply at line ${index + 1}`);
    if (kind === 'equal') result.push(line);
    index += 1;
  }
  return result;
}

export function diffStats(ops: readonly DiffOp[]): { added: number; removed: number } {
  return { added: ops.filter(({ kind }) => kind === 'insert').length, removed: ops.filter(({ kind }) => kind === 'delete').length };
}

/** Lines of a text, without the empty piece after a final newline. */
export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** A unified diff (`---`/`+++` headers, `@@` hunks with `context` lines around changes); empty when equal. */
export function unifiedDiff(params: { a: string; b: string; context?: number; labels?: { a: string; b: string } }): string {
  const { a, b, context = 3, labels = { a: 'a', b: 'b' } } = params;
  const ops = diffLines({ a: splitLines(a), b: splitLines(b) });
  const changed = ops.flatMap(({ kind }, index) => (kind === 'equal' ? [] : [index]));
  if (changed.length === 0) return '';
  // Group changes whose context windows touch into one hunk.
  const hunks: [number, number][] = [];
  for (const index of changed) {
    const last = hunks.at(-1);
    if (last != null && index - last[1] - 1 <= 2 * context) last[1] = index;
    else hunks.push([index, index]);
  }
  const lines = [`--- ${labels.a}`, `+++ ${labels.b}`];
  for (const [first, last] of hunks) {
    const start = Math.max(0, first - context);
    const end = Math.min(ops.length - 1, last + context);
    const before = ops.slice(0, start);
    const aStart = before.filter(({ kind }) => kind !== 'insert').length + 1;
    const bStart = before.filter(({ kind }) => kind !== 'delete').length + 1;
    const body = ops.slice(start, end + 1);
    const aCount = body.filter(({ kind }) => kind !== 'insert').length;
    const bCount = body.filter(({ kind }) => kind !== 'delete').length;
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...body.map(({ kind, line }) => `${kind === 'equal' ? ' ' : kind === 'delete' ? '-' : '+'}${line}`));
  }
  return `${lines.join('\n')}\n`;
}
