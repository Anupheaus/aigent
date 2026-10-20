import { describe, expect, it } from 'vitest';
import { createMemoryFsAccess } from '../../../security/fs-access-memory.js';
import { createFsPolicy } from '../../../security/fs-policy.js';
import { createFsDelete } from './fs-delete.js';
import { createFsMove } from './fs-move.js';
import { createFsStat } from './fs-stat.js';
import { createFsWrite } from './fs-write.js';
import { call, CONTEXT, entriesOf, memoryDeps, textAt } from './fs-tools.test-support.js';
import type { FsDeps } from './fs-shared.js';

const gate = (tool: { requiresApproval?: unknown }, items: unknown[]): boolean => (tool.requiresApproval as (args: unknown, context: unknown) => boolean)({ items }, CONTEXT);

describe('approval rules see the canonical path (I1)', () => {
  const important = { approval: ({ path }: { path: string }) => path.startsWith('/ws/important') };

  it('asks for every spelling of a protected path: relative, with .., doubled separators', () => {
    const deps = memoryDeps({ files: { '/ws/important/x.txt': 'x', '/ws/sub/a.txt': 'a' }, policy: important });
    const write = createFsWrite(deps);
    for (const path of ['/ws/important/x.txt', 'important/x.txt', '/ws/sub/../important/x.txt', '/ws//important/./x.txt', './important/x.txt']) {
      expect(gate(write, [{ path, content: 'y' }])).toBe(true);
    }
    expect(gate(write, [{ path: 'sub/a.txt', content: 'y' }])).toBe(false);
    expect(gate(createFsDelete(deps), [{ path: 'sub/../important/x.txt' }])).toBe(true);
    expect(gate(createFsMove(deps), [{ from: 'sub/a.txt', to: './important/a.txt' }])).toBe(true);
  });

  it('applies Windows spellings (forward slashes, case) before the rule', () => {
    const access = createMemoryFsAccess({ platform: 'win32', files: { 'C:\\ws\\Important\\x.txt': 'x' } });
    const deps: FsDeps = {
      access, approvals: 'none', clock: { now: () => 1 },
      policy: createFsPolicy({ roots: [{ path: 'C:\\ws', permissions: ['read', 'write', 'delete'] }], approval: ({ path }) => path.toLowerCase().startsWith('c:\\ws\\important'), platform: 'win32' }),
    };
    expect(gate(createFsWrite(deps), [{ path: 'c:/ws/sub/../important/x.txt', content: 'y' }])).toBe(true);
  });

  it('refuses at run time when a link hides a protected path from the gate, rather than acting unapproved', async () => {
    const deps = memoryDeps({ files: { '/ws/important/x.txt': 'x', '/ws/alias': { symlink: '/ws/important' } }, policy: important });
    const write = createFsWrite(deps);
    expect(gate(write, [{ path: 'alias/x.txt', content: 'y', overwrite: true }])).toBe(false);
    const [entry] = entriesOf(await call({ tool: write, items: [{ path: 'alias/x.txt', content: 'y', overwrite: true }] }));
    expect(entry?.error).toMatchObject({ code: 'approval_required', category: 'denied' });
    expect(await textAt(deps.access, '/ws/important/x.txt')).toBe('x');
  });
});

describe('links are acted on themselves, never their targets (I3)', () => {
  const files = { '/ws/target/keep.txt': 'keep', '/ws/link': { symlink: '/ws/target' }, '/ws/file-link': { symlink: '/ws/target/keep.txt' }, '/ws/dangling': { symlink: '/ws/nowhere' }, '/ws/out': { symlink: '/elsewhere' } } as const;

  it('fs_stat reports the link with its policy-checked target', async () => {
    const deps = memoryDeps({ files: { ...files, '/elsewhere/s.txt': 's' } });
    const entries = entriesOf(await call({ tool: createFsStat(deps), items: [{ path: '/ws/link' }, { path: '/ws/dangling' }, { path: '/ws/out' }] }));
    expect(entries[0]?.result).toMatchObject({ path: '/ws/link', exists: true, type: 'symlink', linkTarget: '/ws/target' });
    expect(entries[1]?.result).toMatchObject({ path: '/ws/dangling', type: 'symlink', linkTarget: null, dangling: true });
    expect(entries[2]?.result).toMatchObject({ path: '/ws/out', type: 'symlink', linkTarget: null, linkTargetRefused: 'outside_roots' });
  });

  it('fs_delete removes the link and leaves its target alone (recursive or not)', async () => {
    for (const backupDir of ['/backups', null] as const) {
      const deps = memoryDeps({ files, backupDir });
      const entries = entriesOf(await call({ tool: createFsDelete(deps), items: [{ path: '/ws/link', recursive: true }, { path: '/ws/file-link' }, { path: '/ws/dangling' }] }));
      expect(entries.map(({ ok, result }) => (ok ? result?.type : 'failed'))).toEqual(['symlink', 'symlink', 'symlink']);
      expect(await textAt(deps.access, '/ws/target/keep.txt')).toBe('keep');
      await expect(deps.access.lstat('/ws/link')).rejects.toMatchObject({ details: { fsCode: 'ENOENT' } });
    }
  });

  it('fs_move renames the link, not its target', async () => {
    const deps = memoryDeps({ files });
    const [entry] = entriesOf(await call({ tool: createFsMove(deps), items: [{ from: '/ws/link', to: '/ws/renamed' }] }));
    expect(entry?.result).toMatchObject({ from: '/ws/link', to: '/ws/renamed' });
    expect((await deps.access.lstat('/ws/renamed')).type).toBe('symlink');
    expect(await textAt(deps.access, '/ws/target/keep.txt')).toBe('keep');
  });
});
