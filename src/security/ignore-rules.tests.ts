import { describe, expect, it } from 'vitest';
import { createIgnoreMatcher, DEFAULT_SEARCH_IGNORES, parseIgnoreFile } from './ignore-rules.js';

describe('.gitignore-style rules', () => {
  const rules = parseIgnoreFile([
    '# comment', '', 'node_modules/', '*.log', '!keep.log', '/build', 'docs/*.tmp', '\\#hash', 'trailing   ', '**/cache/**',
  ].join('\n'));
  const isIgnored = createIgnoreMatcher({ rules });

  it.each<[string, boolean, boolean]>([
    ['node_modules', true, true],
    ['pkg/node_modules', true, true],
    ['node_modules', false, false],
    ['app.log', false, true],
    ['deep/dir/app.log', false, true],
    ['keep.log', false, false],
    ['build', true, true],
    ['src/build', true, false],
    ['docs/a.tmp', false, true],
    ['docs/sub/a.tmp', false, false],
    ['#hash', false, true],
    ['trailing', false, true],
    ['x/cache/y.txt', false, true],
    ['src/main.ts', false, false],
  ])('%s (directory: %s) ignored: %s', (path, isDirectory, expected) => {
    expect(isIgnored({ path, isDirectory })).toBe(expected);
  });

  it('ignores dependencies, VCS data, build output, lockfiles and minified files by default', () => {
    const defaults = createIgnoreMatcher({ rules: parseIgnoreFile(DEFAULT_SEARCH_IGNORES.join('\n')) });
    for (const [path, isDirectory] of [['node_modules', true], ['a/.git', true], ['dist', true], ['package-lock.json', false], ['web/app.min.js', false]] as const) {
      expect(defaults({ path, isDirectory })).toBe(true);
    }
    expect(defaults({ path: 'src/app.js', isDirectory: false })).toBe(false);
  });
});
