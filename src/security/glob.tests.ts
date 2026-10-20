import { describe, expect, it } from 'vitest';
import { globRegExp, matchGlob } from './glob.js';

describe('matchGlob', () => {
  it.each<[string, string, boolean]>([
    ['*.ts', 'a.ts', true],
    ['*.ts', 'dir/a.ts', false],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'dir/sub/a.ts', true],
    ['**/.git/**', '.git/config', true],
    ['**/.git/**', 'repo/.git/objects/ab', true],
    ['**/.git/**', 'repo/.gitignore', false],
    ['**/.env', '.env', true],
    ['**/.env', 'app/.env', true],
    ['**/.env.*', 'app/.env.local', true],
    ['**/.env.*', 'app/.envrc', false],
    ['src/**', 'src/a/b.ts', true],
    ['src/**', 'srcx/a.ts', false],
    ['a?c', 'abc', true],
    ['a?c', 'a/c', false],
    ['[ab]x', 'bx', true],
    ['[!ab]x', 'cx', true],
    ['[!ab]x', 'ax', false],
    ['[a-c]1', 'b1', true],
    ['*.{js,ts}', 'a.ts', true],
    ['*.{js,ts}', 'a.css', false],
    ['a.b', 'axb', false],
    ['(x)+', '(x)+', true],
    ['lone}brace]', 'lone}brace]', true],
    ['**', 'anything/at/all', true],
  ])('%s against %s is %s', (pattern, path, expected) => {
    expect(matchGlob(pattern, path)).toBe(expected);
  });

  it('matches case-insensitively when asked', () => {
    expect(matchGlob('**/*.PEM', 'keys/a.pem')).toBe(false);
    expect(globRegExp({ pattern: '**/*.PEM', caseSensitive: false }).test('keys/a.pem')).toBe(true);
  });
});
