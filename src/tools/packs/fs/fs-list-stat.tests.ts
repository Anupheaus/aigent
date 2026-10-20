import { describe, expect, it } from 'vitest';
import { createFsList } from './fs-list.js';
import { createFsStat } from './fs-stat.js';
import { call, entriesOf, memoryDeps } from './fs-tools.test-support.js';

const FILES = {
  '/ws/src/a.ts': 'a', '/ws/src/b.ts': 'bb', '/ws/src/deep/c.ts': 'ccc', '/ws/README.md': 'r', '/ws/.env': 'k', '/ws/.hidden': 'h',
  '/ws/node_modules/pkg/index.js': 'x', '/ws/.git/config': 'g', '/ws/link': { symlink: '/outside' }, '/outside/secret.txt': 's',
};

describe('fs_stat', () => {
  it('describes files, directories and missing paths, and refuses paths outside the roots', async () => {
    const deps = memoryDeps({ files: FILES });
    const entries = entriesOf(await call({ tool: createFsStat(deps), items: [{ path: '/ws/src/a.ts' }, { path: '/ws/src' }, { path: '/ws/nope' }, { path: '/outside/secret.txt' }] }));
    expect(entries[0]?.result).toMatchObject({ path: '/ws/src/a.ts', exists: true, type: 'file', size: 1, mtimeMs: expect.any(Number) });
    expect(entries[1]?.result).toMatchObject({ exists: true, type: 'directory' });
    expect(entries[2]?.result).toEqual({ path: '/ws/nope', exists: false });
    expect(entries[3]).toMatchObject({ ok: false, error: { category: 'denied', code: 'outside_roots' } });
  });
});

describe('fs_list', () => {
  it('lists one level sorted, counting what it skipped and why', async () => {
    const deps = memoryDeps({ files: FILES });
    const [entry] = entriesOf(await call({ tool: createFsList(deps), items: [{ path: '/ws' }] }));
    expect(entry?.result).toMatchObject({
      path: '/ws',
      entries: [{ path: 'README.md', type: 'file', size: 1 }, { path: 'link', type: 'symlink' }, { path: 'node_modules', type: 'directory' }, { path: 'src', type: 'directory' }],
      counts: { files: 1, directories: 2, symlinks: 1, other: 0 },
      skipped: { counts: { denied: 2, hidden: 1 } },
      truncated: false,
    });
  });

  it('walks recursively to a depth, with a glob, never following symlinks, and leaving ignored directories out', async () => {
    const deps = memoryDeps({ files: FILES });
    const [entry] = entriesOf(await call({ tool: createFsList(deps), items: [{ path: '/ws', recursive: true, glob: '**/*.ts' }] }));
    expect((entry?.result?.entries as { path: string }[]).map(({ path }) => path)).toEqual(['src/a.ts', 'src/b.ts', 'src/deep/c.ts']);
    expect(entry?.result).toMatchObject({ skipped: { counts: { ignored: 1 }, samples: { ignored: ['node_modules'] } } });
    const [shallow] = entriesOf(await call({ tool: createFsList(deps), items: [{ path: '/ws', recursive: true, depth: 1, glob: '**/*.ts' }] }));
    expect((shallow?.result?.entries as { path: string }[]).map(({ path }) => path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('truncates at the limit and says so', async () => {
    const deps = memoryDeps({ files: FILES });
    const [entry] = entriesOf(await call({ tool: createFsList(deps), items: [{ path: '/ws/src', recursive: true, limit: 2 }] }));
    expect(entry?.result).toMatchObject({ truncated: true });
    expect(entry?.result?.entries).toHaveLength(2);
  });

  it('refuses listing outside the roots and a file', async () => {
    const deps = memoryDeps({ files: FILES });
    const entries = entriesOf(await call({ tool: createFsList(deps), items: [{ path: '/outside' }, { path: '/ws/link' }, { path: '/ws/README.md' }] }));
    expect(entries.map(({ ok, error }) => (ok ? 'ok' : error?.code))).toEqual(['outside_roots', 'outside_roots', 'not_a_directory']);
  });
});
