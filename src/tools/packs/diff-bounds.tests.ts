import { describe, expect, it } from 'vitest';
import { applyDiff, diffLines, diffTexts, MAX_EDIT_DISTANCE, unifiedDiff } from './diff.js';

const MIB = 1_048_576;
/** Generous: the old algorithm used gigabytes on these inputs, the bounded one a few megabytes. */
const MAX_HEAP_GROWTH = 200 * MIB;

const numbered = (count: number, prefix: string): string[] => Array.from({ length: count }, (_unused, index) => `${prefix}${index}`);

function heapGrowth(work: () => void): number {
  const before = process.memoryUsage().heapUsed;
  work();
  return process.memoryUsage().heapUsed - before;
}

describe('diffLines bounds (linear memory, bounded work)', () => {
  it('diffs an empty side against 50k lines without quadratic memory', () => {
    const b = numbered(50_000, 'line ');
    let ops: ReturnType<typeof diffLines> = [];
    expect(heapGrowth(() => { ops = diffLines({ a: [], b }); })).toBeLessThan(MAX_HEAP_GROWTH);
    expect(applyDiff({ a: [], ops })).toEqual(b);
    expect(applyDiff({ a: b, ops: diffLines({ a: b, b: [] }) })).toEqual([]);
  });

  it('diffs one line against 50k lines', () => {
    const b = numbered(50_000, 'line ');
    const ops = diffLines({ a: ['line 25000'], b });
    expect(applyDiff({ a: ['line 25000'], ops })).toEqual(b);
  });

  it('falls back to a correct, non-minimal script when two large texts differ everywhere', () => {
    const a = numbered(30_000, 'a');
    const b = numbered(30_000, 'b');
    const started = performance.now();
    let result: ReturnType<typeof diffTexts> | undefined;
    expect(heapGrowth(() => { result = diffTexts({ a: `${a.join('\n')}\n`, b: `${b.join('\n')}\n` }); })).toBeLessThan(MAX_HEAP_GROWTH);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result?.isMinimal).toBe(false);
    expect(result?.ops.filter(({ kind }) => kind === 'insert')).toHaveLength(30_000);
  });

  it('stays minimal for edits within the edit-distance bound, keeping common prefix and suffix', () => {
    const a = numbered(20_000, 'x');
    const b = [...a.slice(0, 10_000), 'new', ...a.slice(10_001)];
    const result = diffTexts({ a: a.join('\n'), b: b.join('\n') });
    expect(result.isMinimal).toBe(true);
    expect(result.ops.filter(({ kind }) => kind !== 'equal')).toEqual([{ kind: 'delete', line: 'x10000' }, { kind: 'insert', line: 'new' }]);
    expect(MAX_EDIT_DISTANCE).toBeGreaterThan(100);
  });
});

describe('unifiedDiff details', () => {
  it('uses -0,0 for an insertion into an empty text and the line before for a pure insertion', () => {
    expect(unifiedDiff({ a: '', b: 'x\ny\n' })).toBe(['--- a', '+++ b', '@@ -0,0 +1,2 @@', '+x', '+y', ''].join('\n'));
    expect(unifiedDiff({ a: 'a\nb\n', b: 'a\nnew\nb\n', context: 0 })).toBe(['--- a', '+++ b', '@@ -1,0 +2,1 @@', '+new', ''].join('\n'));
  });

  it('marks a missing final newline, so texts that differ only there do not diff as equal', () => {
    expect(unifiedDiff({ a: 'x', b: 'x\n' })).toBe(['--- a', '+++ b', '@@ -1,1 +1,1 @@', '-x', '\\ No newline at end of file', '+x', ''].join('\n'));
    expect(diffTexts({ a: 'x', b: 'x\n' }).ops).toHaveLength(2);
  });

  it('renders many scattered changes past the edit-distance bound as many small hunks (unique lines anchor them)', () => {
    const a = numbered(40_000, 'l');
    const b = a.map((line, index) => (index % 10 === 0 ? `${line}!` : line));
    const started = performance.now();
    const text = unifiedDiff({ a: a.join('\n'), b: b.join('\n'), context: 0 });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(text.split('\n@@').length - 1).toBe(4_000);
  });
});

describe('anchored fallback', () => {
  it('property: past the bounds the script still turns a into b', () => {
    // Mostly repeated lines (no anchors) plus unique ones (anchors), with far more than MAX_EDIT_DISTANCE changes.
    const lineOf = (seed: number, index: number): string => (((seed * 31 + index * 17) % 7 === 0) ? `unique ${index}` : `common ${(seed + index) % 5}`);
    for (const seed of [1, 2, 3]) {
      const a = Array.from({ length: 6_000 }, (_unused, index) => lineOf(seed, index));
      const b = Array.from({ length: 6_000 }, (_unused, index) => lineOf(seed + 1, index));
      const result = diffTexts({ a: `${a.join('\n')}\n`, b: `${b.join('\n')}\n` });
      expect(result.isMinimal).toBe(false);
      expect(applyDiff({ a, ops: result.ops })).toEqual(b);
    }
  });
});
