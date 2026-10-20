import { myersDiff } from './myers.js';
import type { DiffOp, LineDiff } from './myers.js';

export type { DiffOp, LineDiff } from './myers.js';
export { MAX_EDIT_DISTANCE } from './myers.js';

/** Appended (after a `\n`, which no line holds) to a final line that has no newline, so it never equals one that has. */
const NO_EOL_KEY = '\n';
const NO_EOL_MARKER = '\\ No newline at end of file';

/** The shortest edit script from `a` to `b` (bounded: see `myersDiff`): equal, deleted and inserted lines in order. */
export function diffLines(params: { a: readonly string[]; b: readonly string[] }): DiffOp[] {
  return myersDiff(params).ops;
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
  let added = 0;
  let removed = 0;
  for (const { kind } of ops) {
    if (kind === 'insert') added += 1;
    if (kind === 'delete') removed += 1;
  }
  return { added, removed };
}

/** Lines of a text, without the empty piece after a final newline. */
export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Lines of a text where a final line without a newline is keyed apart (see `NO_EOL_KEY`). */
function keyedLines(text: string): string[] {
  const lines = splitLines(text);
  if (text !== '' && !text.endsWith('\n') && lines.length > 0) lines[lines.length - 1] += NO_EOL_KEY;
  return lines;
}

/** A line diff of two texts that also tells a missing final newline apart (render it with `renderUnifiedDiff`). */
export function diffTexts(params: { a: string; b: string }): LineDiff {
  return myersDiff({ a: keyedLines(params.a), b: keyedLines(params.b) });
}

/** One rendered op: a final line without newline is followed by the `\ No newline at end of file` marker. */
function renderOp({ kind, line }: DiffOp): string[] {
  const sign = kind === 'equal' ? ' ' : kind === 'delete' ? '-' : '+';
  return line.endsWith(NO_EOL_KEY) ? [`${sign}${line.slice(0, -NO_EOL_KEY.length)}`, NO_EOL_MARKER] : [`${sign}${line}`];
}

/** `start,count` of a hunk side; an empty side names the line before it (`-0,0` for an empty file), as GNU diff does. */
function range(params: { start: number; count: number }): string {
  const { start, count } = params;
  return `${count === 0 ? start - 1 : start},${count}`;
}

/** A unified diff of `diffTexts` ops (`---`/`+++` headers, `@@` hunks with `context` lines); empty when equal. */
export function renderUnifiedDiff(params: { ops: readonly DiffOp[]; context?: number; labels?: { a: string; b: string } }): string {
  const { ops, context = 3, labels = { a: 'a', b: 'b' } } = params;
  // Line numbers before each op, computed once so rendering stays linear in the number of ops.
  const aLineAt = new Int32Array(ops.length + 1);
  const bLineAt = new Int32Array(ops.length + 1);
  const hunks: [number, number][] = [];
  for (const [index, { kind }] of ops.entries()) {
    aLineAt[index + 1] = (aLineAt[index] ?? 0) + (kind === 'insert' ? 0 : 1);
    bLineAt[index + 1] = (bLineAt[index] ?? 0) + (kind === 'delete' ? 0 : 1);
    if (kind === 'equal') continue;
    // Changes whose context windows touch share one hunk.
    const last = hunks.at(-1);
    if (last != null && index - last[1] - 1 <= 2 * context) last[1] = index;
    else hunks.push([index, index]);
  }
  if (hunks.length === 0) return '';
  const lines = [`--- ${labels.a}`, `+++ ${labels.b}`];
  for (const [first, last] of hunks) {
    const start = Math.max(0, first - context);
    const end = Math.min(ops.length - 1, last + context);
    const aStart = (aLineAt[start] ?? 0) + 1;
    const bStart = (bLineAt[start] ?? 0) + 1;
    const aCount = (aLineAt[end + 1] ?? 0) - (aLineAt[start] ?? 0);
    const bCount = (bLineAt[end + 1] ?? 0) - (bLineAt[start] ?? 0);
    lines.push(`@@ -${range({ start: aStart, count: aCount })} +${range({ start: bStart, count: bCount })} @@`);
    for (const op of ops.slice(start, end + 1)) lines.push(...renderOp(op));
  }
  return `${lines.join('\n')}\n`;
}

/** A unified diff (`---`/`+++` headers, `@@` hunks with `context` lines around changes); empty when equal. */
export function unifiedDiff(params: { a: string; b: string; context?: number; labels?: { a: string; b: string } }): string {
  const { a, b, ...rest } = params;
  return renderUnifiedDiff({ ops: diffTexts({ a, b }).ops, ...rest });
}
