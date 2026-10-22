import { describe, expect, it } from 'vitest';
import { BUG_CAUSES, BUGS, EXTRA_LOOKALIKES, LOOKALIKES } from '../generate/families/bug-constructs.js';
import { findBugs } from './bug-truth.js';

const file = (lines: string[]): Map<string, string> => new Map([['src/x/x.ts', `${lines.join('\n')}\n`]]);

describe('bug truth', () => {
  it.each(BUG_CAUSES)('finds the %s bug at its line', cause => {
    const construct = BUGS[cause]('subject');
    expect(findBugs(file(construct.lines))).toEqual([{ path: 'src/x/x.ts', line: construct.at + 1, cause }]);
  });

  it.each(BUG_CAUSES)('passes every %s look-alike', cause => {
    for (const build of LOOKALIKES[cause]) expect(findBugs(file(build('subject').lines))).toEqual([]);
  });

  it('passes deprecated and TODO-marked correct code, and ignores tests', () => {
    for (const build of EXTRA_LOOKALIKES) expect(findBugs(file(build('subject').lines))).toEqual([]);
    expect(findBugs(new Map([['src/x/x.test.ts', BUGS['off-by-one']('subject').lines.join('\n')]]))).toEqual([]);
  });

  it('keeps line numbers when several constructs share a file', () => {
    const first = BUGS['null-deref']('a');
    const second = BUGS.timezone('b');
    expect(findBugs(file([...first.lines, '', ...second.lines]))).toEqual([
      { path: 'src/x/x.ts', line: first.at + 1, cause: 'null-deref' },
      { path: 'src/x/x.ts', line: first.lines.length + 1 + second.at + 1, cause: 'timezone' },
    ]);
  });
});
