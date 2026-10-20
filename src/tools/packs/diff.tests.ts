import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyDiff, diffLines, diffStats, unifiedDiff } from './diff.js';

describe('diffLines (Myers)', () => {
  it('finds a shortest edit script', () => {
    expect(diffLines({ a: ['a', 'b', 'c', 'a', 'b', 'b', 'a'], b: ['c', 'b', 'a', 'b', 'a', 'c'] }).filter(({ kind }) => kind !== 'equal')).toHaveLength(5);
    expect(diffLines({ a: ['x'], b: ['x'] })).toEqual([{ kind: 'equal', line: 'x' }]);
    expect(diffLines({ a: [], b: ['n'] })).toEqual([{ kind: 'insert', line: 'n' }]);
    expect(diffLines({ a: ['o'], b: [] })).toEqual([{ kind: 'delete', line: 'o' }]);
  });

  it('property: applying the diff to a yields b, and its stats count the changes', () => {
    const lines = fc.array(fc.constantFrom('a', 'b', 'c', 'd', ''), { maxLength: 30 });
    fc.assert(fc.property(lines, lines, (a, b) => {
      const ops = diffLines({ a, b });
      expect(applyDiff({ a, ops })).toEqual(b);
      const { added, removed } = diffStats(ops);
      expect(a.length - removed + added).toBe(b.length);
    }), { numRuns: 500 });
  });
});

describe('unifiedDiff', () => {
  it('renders hunks with context and @@ ranges', () => {
    const text = unifiedDiff({ a: 'one\ntwo\nthree\nfour\nfive\n', b: 'one\ntwo\n3\nfour\nfive\nsix\n', context: 1, labels: { a: 'a.txt', b: 'b.txt' } });
    expect(text).toBe(['--- a.txt', '+++ b.txt', '@@ -2,4 +2,5 @@', ' two', '-three', '+3', ' four', ' five', '+six', ''].join('\n'));
  });

  it('is empty for equal texts', () => {
    expect(unifiedDiff({ a: 'same\n', b: 'same\n' })).toBe('');
  });
});
