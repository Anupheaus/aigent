import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { MemoryFsEntry } from '../../../security/fs-access-memory.js';
import { createFsSearch } from './fs-search.js';
import { fsTools } from './fs-tools.js';
import { call, entriesOf, memoryDeps } from './fs-tools.test-support.js';

interface SearchFile {
  path: string;
  matches: { line: number; column: number; text: string; before?: string[]; after?: string[] }[];
  count: number;
}

describe('fs_search', () => {
  const files = {
    '/ws/src/a.ts': 'import x from "y";\nconst value = 1;\nconst Value = 2;\n',
    '/ws/src/b.ts': 'no hits here\n',
    '/ws/src/notes.md': 'value is valued\n',
    '/ws/node_modules/lib/value.js': 'value\n',
    '/ws/.env': 'value=secret\n',
    '/ws/img.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
  };

  it('finds content matches with line numbers, columns and context, counts first, skips reported', async () => {
    const deps = memoryDeps({ files });
    const [entry] = entriesOf(await call({ tool: createFsSearch(deps), items: [{ path: '/ws', pattern: 'value', kind: 'content', contextLines: 1 }] }));
    expect(entry?.result).toMatchObject({ totalMatches: 4, filesWithMatches: 2, truncated: false });
    const found = entry?.result?.files as SearchFile[];
    expect(found.map(({ path, count }) => ({ path, count }))).toEqual([{ path: 'src/a.ts', count: 2 }, { path: 'src/notes.md', count: 2 }]);
    expect(found[0]?.matches[0]).toEqual({ line: 2, column: 7, text: 'const value = 1;', before: ['import x from "y";'], after: ['const Value = 2;'] });
    expect(entry?.result).toMatchObject({ skipped: { counts: { ignored: 1, binary: 1, denied: 1 } } });
  });

  it('honours caseSensitive, wholeWord, regex and glob', async () => {
    const deps = memoryDeps({ files });
    const tool = createFsSearch(deps);
    const run = async (item: Record<string, unknown>) => entriesOf(await call({ tool, items: [{ path: '/ws', kind: 'content', ...item }] }))[0]?.result?.totalMatches;
    expect(await run({ pattern: 'value', caseSensitive: true })).toBe(3);
    expect(await run({ pattern: 'value', wholeWord: true })).toBe(3);
    expect(await run({ pattern: 'const \\w+ =', regex: true })).toBe(2);
    expect(await run({ pattern: 'value', glob: '**/*.md' })).toBe(2);
    expect(await run({ pattern: 'value', includeIgnored: true })).toBe(5);
  });

  it('finds files by name', async () => {
    const deps = memoryDeps({ files });
    const [entry] = entriesOf(await call({ tool: createFsSearch(deps), items: [{ path: '/ws', pattern: '.ts', kind: 'name' }] }));
    expect((entry?.result?.files as SearchFile[]).map(({ path }) => path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('caps matches with a follow-up hint and refuses unsafe patterns', async () => {
    const deps = memoryDeps({ files: { '/ws/many.txt': 'hit\n'.repeat(30) } });
    const tool = createFsSearch(deps);
    const [capped] = entriesOf(await call({ tool, items: [{ path: '/ws', pattern: 'hit', kind: 'content', maxMatches: 10 }] }));
    expect(capped?.result).toMatchObject({ totalMatches: 30, shownMatches: 10, truncated: true, hint: expect.stringContaining('maxMatches') });
    const [unsafe] = entriesOf(await call({ tool, items: [{ path: '/ws', pattern: '(a+)+$', regex: true, kind: 'content' }] }));
    expect(unsafe).toMatchObject({ ok: false, error: { code: 'unsafe_pattern' } });
  });

  it('never reports a phantom match nor silently skips an in-scope file, against an exhaustive scan of 500 files', async () => {
    const words = ['alpha', 'beta', 'needle', 'gamma', 'Needle', 'needles'];
    const fileArbitrary = fc.record({
      dir: fc.constantFrom('src', 'src/deep', 'lib', 'node_modules/pkg', 'docs'),
      lines: fc.array(fc.array(fc.constantFrom(...words), { maxLength: 6 }).map(line => line.join(' ')), { maxLength: 12 }),
      kind: fc.constantFrom('text', 'text', 'text', 'binary', 'big', 'secret'),
    });
    const generated = fc.sample(fc.array(fileArbitrary, { minLength: 500, maxLength: 500 }), { numRuns: 1, seed: 42 })[0] ?? [];
    const tree: Record<string, MemoryFsEntry> = {};
    const expected = { matches: new Map<string, number>(), ignored: 0, binary: 0, tooLarge: 0, denied: 0 };
    generated.forEach(({ dir, lines, kind }, index) => {
      const name = kind === 'secret' ? `${dir}/k${index}.pem` : `${dir}/f${index}.txt`;
      const text = kind === 'big' ? 'needle '.repeat(400) : lines.join('\n');
      tree[`/ws/${name}`] = kind === 'binary' ? new Uint8Array([0, 1, 2, 3]) : text;
      // The reference scan: what an exhaustive, rule-following search must report.
      if (dir.startsWith('node_modules')) { if (dir === 'node_modules/pkg' && index === generated.findIndex(file => file.dir === 'node_modules/pkg')) expected.ignored += 1; return; }
      if (kind === 'secret') { expected.denied += 1; return; }
      if (kind === 'binary') { expected.binary += 1; return; }
      if (kind === 'big') { expected.tooLarge += 1; return; }
      const count = text.split('\n').reduce((total, line) => total + (line.match(/needle/gi)?.length ?? 0), 0);
      if (count > 0) expected.matches.set(name, count);
    });
    const deps = memoryDeps({ files: tree, policy: { maxReadBytes: 2_000 } });
    const [entry] = entriesOf(await call({ tool: createFsSearch(deps), items: [{ path: '/ws', pattern: 'needle', kind: 'content', maxMatches: 500 }] }));
    const result = entry?.result as { totalMatches: number; files: SearchFile[]; skipped: { counts: Record<string, number> } };
    expect(Object.fromEntries(result.files.map(({ path, count }) => [path, count]))).toEqual(Object.fromEntries(expected.matches));
    expect(result.totalMatches).toBe([...expected.matches.values()].reduce((total, count) => total + count, 0));
    expect(result.skipped.counts).toMatchObject({ ignored: expected.ignored, binary: expected.binary, tooLarge: expected.tooLarge, denied: expected.denied });
    // Every reported match is really in its file, at its line and column.
    for (const { path, matches } of result.files) {
      const lines = String(tree[`/ws/${path}`]).split('\n');
      for (const { line, column } of matches) expect(lines[line - 1]?.slice(column - 1, column - 1 + 'needle'.length).toLowerCase()).toBe('needle');
    }
  });
});

describe('fs_search layers and ranking', () => {
  const files = {
    '/ws/src/use.ts': 'total(1);\ntotal(2);\ntotal(3);\n',
    '/ws/src/def.ts': 'export function total(value: number) {\n  return value;\n}\n',
    '/ws/src/other.ts': 'const subtotal = 1;\n',
  };

  it('returns only files and counts in the files layer, and only totals in the counts layer, never cut by maxMatches', async () => {
    const tool = createFsSearch(memoryDeps({ files }));
    const [byFile] = entriesOf(await call({ tool, items: [{ path: '/ws', pattern: 'total', kind: 'content', wholeWord: true, layer: 'files', maxMatches: 1 }] }));
    expect(byFile?.result).toMatchObject({ totalMatches: 4, filesWithMatches: 2, truncated: false, files: [{ path: 'src/def.ts', count: 1, defines: true }, { path: 'src/use.ts', count: 3 }] });
    expect(JSON.stringify(byFile?.result)).not.toContain('"matches"');
    const [counts] = entriesOf(await call({ tool, items: [{ path: '/ws', pattern: 'total', kind: 'content', layer: 'counts' }] }));
    expect(counts?.result).toMatchObject({ totalMatches: 5, filesWithMatches: 3 });
    expect(counts?.result?.['files']).toBeUndefined();
  });

  it('orders by relevance (definitions first, then match count) and summarises what was not shown', async () => {
    const tool = createFsSearch(memoryDeps({ files }));
    const [ranked] = entriesOf(await call({ tool, items: [{ path: '/ws', pattern: 'total', kind: 'content', order: 'relevance', maxMatches: 2 }] }));
    expect((ranked?.result?.['files'] as SearchFile[]).map(({ path }) => path)).toEqual(['src/def.ts', 'src/use.ts', 'src/other.ts']);
    expect(ranked?.result).toMatchObject({ truncated: true, more: { matches: 3, files: 1 } });
  });

  it('marks a definition from every match, not only the lines kept under maxMatches', async () => {
    // The defining file sorts last by path, so maxMatches is used up before its lines are kept.
    const tool = createFsSearch(memoryDeps({ files: { '/ws/src/a-use.ts': 'total(1);\ntotal(2);\ntotal(3);\n', '/ws/src/z-def.ts': 'export function total(value: number) {\n  return value;\n}\n' } }));
    for (const layer of ['files', 'matches'] as const) {
      const [ranked] = entriesOf(await call({ tool, items: [{ path: '/ws', pattern: 'total', kind: 'content', wholeWord: true, order: 'relevance', layer, maxMatches: 2 }] }));
      expect((ranked?.result?.['files'] as SearchFile[])[0], layer).toMatchObject({ path: 'src/z-def.ts', defines: true });
    }
  });
});

describe('fs_search bounds and skips', () => {
  it('runs regex searches in a worker: a slow pattern stops at the budget with this thread responsive', async () => {
    const deps = memoryDeps({ files: { '/ws/slow.txt': `${'a'.repeat(3_000)}\n`, '/ws/later.txt': 'a!\n' } });
    let last = performance.now();
    let longestGap = 0;
    const ticker = setInterval(() => { const now = performance.now(); longestGap = Math.max(longestGap, now - last); last = now; }, 10);
    const [entry] = entriesOf(await call({ tool: createFsSearch(deps), items: [{ path: '/ws', pattern: '.*a.*a.*a.*a.*!', kind: 'content', regex: true }] }));
    clearInterval(ticker);
    expect(entry?.result).toMatchObject({ truncated: true, stoppedBy: 'time budget', hint: expect.stringContaining('budget') });
    expect(longestGap).toBeLessThan(500);
  }, 30_000);

  it('takes its regex budget from searchBudgetMs, and names it in the hint', async () => {
    const budgetMs = 200;
    const deps = { ...memoryDeps({ files: { '/ws/slow.txt': `${'a'.repeat(3_000)}\n` } }), searchBudgetMs: budgetMs };
    const started = performance.now();
    const [entry] = entriesOf(await call({ tool: createFsSearch(deps), items: [{ path: '/ws', pattern: '.*a.*a.*a.*a.*!', kind: 'content', regex: true }] }));
    expect(entry?.result).toMatchObject({ truncated: true, stoppedBy: 'time budget', hint: expect.stringContaining(`its ${budgetMs} ms budget`) });
    // Well under the 10 s default: the given budget, not the default, stopped it.
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it('refuses a searchBudgetMs that is not a positive integer', () => {
    const { policy, access } = memoryDeps();
    for (const searchBudgetMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => fsTools({ policy, access, searchBudgetMs }), String(searchBudgetMs)).toThrow(/searchBudgetMs must be a positive integer/);
    }
  });

  it('matches regex names in the worker and counts link entries as skipped', async () => {
    const deps = memoryDeps({ files: { '/ws/src/app.ts': 'x', '/ws/src/app.test.ts': 'x', '/ws/link': { symlink: '/ws/src' } } });
    const [named] = entriesOf(await call({ tool: createFsSearch(deps), items: [{ path: '/ws', pattern: '^app\\.(test\\.)?ts$', kind: 'name', regex: true }] }));
    expect(named?.result).toMatchObject({ totalMatches: 2, files: [{ path: 'src/app.test.ts' }, { path: 'src/app.ts' }], skipped: { counts: { link: 1 } } });
  });

  it('skips a file whose invalid UTF-8 lies past the binary sample instead of searching replacement characters', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode(`needle\n${'x'.repeat(9_000)}\n`), 0xff, 0xfe, 0x80]);
    const deps = memoryDeps({ files: { '/ws/odd.txt': bytes } });
    const [entry] = entriesOf(await call({ tool: createFsSearch(deps), items: [{ path: '/ws', pattern: 'needle', kind: 'content' }] }));
    expect(entry?.result).toMatchObject({ totalMatches: 0, skipped: { counts: { binary: 1 } } });
  });
});
