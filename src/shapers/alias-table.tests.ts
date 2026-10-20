import { describe, expect, it } from 'vitest';
import { aliasTableFromJSON, createAliasTable, expandAliases } from './alias-table.js';

const LONG_A = 'src/components/theme/ThemeProvider.tsx';
const LONG_B = 'src/components/theme/useTheme.ts-long-path';

describe('createAliasTable', () => {
  it('gives stable short aliases F1, F2... and reuses them for the same text', () => {
    const table = createAliasTable({ minLength: 24 });
    expect(table.aliasFor(LONG_A)).toBe('F1');
    expect(table.aliasFor(LONG_B)).toBe('F2');
    expect(table.aliasFor(LONG_A)).toBe('F1');
    expect(table.valueOf('F2')).toBe(LONG_B);
    expect(table.valueOf('F9')).toBeUndefined();
    expect(table.has(LONG_A)).toBe(true);
    expect(table.size()).toBe(2);
  });

  it('round-trips through JSON so it can be checkpointed', () => {
    const table = createAliasTable({ minLength: 24 });
    table.aliasFor(LONG_A);
    table.aliasFor(LONG_B);
    const restored = aliasTableFromJSON(JSON.parse(JSON.stringify(table.toJSON())));
    expect(restored.toJSON()).toEqual(table.toJSON());
    expect(restored.aliasFor('a-third-long-string-for-alias')).toBe('F3');
    expect(restored.minLength).toBe(24);
  });
});

describe('expandAliases', () => {
  it('expands exact alias tokens in argument strings, at any depth, without mutating the arguments', () => {
    const table = createAliasTable({ minLength: 24 });
    table.aliasFor(LONG_A);
    const args = { path: 'F1', nested: { list: ['F1', 'x'] }, count: 2 };
    expect(expandAliases(args, table)).toEqual({ path: LONG_A, nested: { list: [LONG_A, 'x'] }, count: 2 });
    expect(args.path).toBe('F1');
  });

  it('leaves unknown aliases, substrings and look-alikes alone', () => {
    const table = createAliasTable({ minLength: 24 });
    table.aliasFor(LONG_A);
    const args = { a: 'F2', b: 'see F1', c: 'F12', d: 'f1', e: ' F1' };
    expect(expandAliases(args, table)).toEqual(args);
  });

  it('returns the arguments untouched for an empty table', () => {
    const args = { path: 'F1' };
    expect(expandAliases(args, createAliasTable({ minLength: 24 }))).toBe(args);
  });
});
