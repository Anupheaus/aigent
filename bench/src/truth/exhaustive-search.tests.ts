import { describe, expect, it } from 'vitest';
import type { RepoTree } from '../generate/repo-types.js';
import { anyCaseFiles, filesNamed, identifierFiles, importedCallFiles, wholeWordFiles } from './exhaustive-search.js';

const tree = (files: Record<string, string>): RepoTree => new Map(Object.entries(files));

describe('exhaustive search (hand-built repositories)', () => {
  it('finds a file by exact name only', () => {
    const repo = tree({ 'src/a/tierDigest.ts': '', 'src/a/tierDigest.old.ts': '', 'src/TierDigest.ts': '', 'dist/tierDigest.ts': '' });
    expect(filesNamed({ tree: repo, name: 'tierDigest.ts' })).toEqual(['dist/tierDigest.ts', 'src/a/tierDigest.ts']);
  });

  it('counts code usage only: no comments, strings, tests, build output, other cases or longer names', () => {
    const repo = tree({
      'src/use.ts': 'export const x = row.tierCode;',
      'src/destructure.js': 'const { tierCode } = input;',
      'src/comment.ts': '// tierCode comes later\nexport const y = 1;',
      'src/string.ts': "log('tierCode missing');",
      'src/longer.ts': 'export const tierCodeLabel = 1;',
      'src/pascal.ts': 'export type TierCode = string;',
      'src/use.test.ts': 'expect(row.tierCode).toBe(1);',
      'dist/use.js': 'row.tierCode;',
      'vendor/lib.min.js': 'a.tierCode',
      'docs/a.md': 'tierCode',
    });
    expect(identifierFiles({ tree: repo, identifier: 'tierCode' })).toEqual(['src/destructure.js', 'src/use.ts']);
    expect(identifierFiles({ tree: repo, identifier: 'tierCode', includeTests: true })).toEqual(['src/destructure.js', 'src/use.test.ts', 'src/use.ts']);
    expect(identifierFiles({ tree: repo, identifier: 'tierCode', exclude: path => path.startsWith('src/use') })).toEqual(['src/destructure.js']);
  });

  it('matches any case and separator, but not near misses or generated files', () => {
    const repo = tree({ 'a.sql': 'tier_code_level', 'b.css': '.tier-code-level {}', 'c.ts': 'TierCodeLevel', 'd.ts': 'tierCodesLevel', 'dist/e.js': 'tierCodeLevel', 'package-lock.json': 'tierCodeLevel' });
    expect(anyCaseFiles({ tree: repo, identifier: 'tierCodeLevel' })).toEqual(['a.sql', 'b.css', 'c.ts']);
  });

  it('matches whole words in any text, exact case', () => {
    const repo = tree({ 'a.ts': '// keep tierRank', 'b.md': 'Set tierRank.', 'c.ts': 'tierRank2', 'd.ts': 'TIER_RANK', 'e.ts': 'const x = "tierRank";', 'f.ts': 'tierRankTable' });
    expect(wholeWordFiles({ tree: repo, word: 'tierRank' })).toEqual(['a.ts', 'b.md', 'e.ts']);
  });

  it('finds callers of an imported function among other uses of the word', () => {
    const repo = tree({
      'src/lib/analytics.ts': 'export function track(event: string): void {}',
      'src/a.ts': "import { track } from './lib/analytics';\ntrack('x');",
      'src/b.ts': "import { track } from './lib/analytics';\nexport const t = 1;",
      'src/c.ts': 'function track(p: number[]) { return p; }\ntrack([1]);',
      'src/d.ts': 'const trackingId = 1; obj.track(1);',
      'src/e.test.ts': "import { track } from './lib/analytics';\ntrack('t');",
    });
    expect(importedCallFiles({ tree: repo, verb: 'track' })).toEqual(['src/a.ts']);
  });
});
