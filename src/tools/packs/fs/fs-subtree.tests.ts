import { describe, expect, it } from 'vitest';
import { createFsDelete } from './fs-delete.js';
import { createFsMove } from './fs-move.js';
import { call, entriesOf, memoryDeps, textAt } from './fs-tools.test-support.js';

const codes = (entries: ReturnType<typeof entriesOf>) => entries.map(({ ok, error }) => (ok ? 'ok' : error?.code));

describe('moving or deleting an ancestor of something protected (I2)', () => {
  const nestedRoot = { roots: [{ path: '/ws', permissions: ['read', 'write', 'delete'] as const }, { path: '/ws/a/ro', permissions: ['read'] as const }].map(root => ({ ...root, permissions: [...root.permissions] })) };

  it('refuses to move a directory that holds a read-only nested root, so the root keeps its protection', async () => {
    const deps = memoryDeps({ files: { '/ws/a/ro/keep.txt': 'keep', '/ws/a/other.txt': 'o' }, policy: nestedRoot });
    const entries = entriesOf(await call({ tool: createFsMove(deps), items: [{ from: '/ws/a', to: '/ws/b' }] }));
    expect(codes(entries)).toEqual(['contains_root']);
    expect(await textAt(deps.access, '/ws/a/ro/keep.txt')).toBe('keep');
  });

  it('refuses to delete a directory that holds a nested root', async () => {
    const deps = memoryDeps({ files: { '/ws/a/ro/keep.txt': 'keep' }, policy: nestedRoot });
    expect(codes(entriesOf(await call({ tool: createFsDelete(deps), items: [{ path: '/ws/a', recursive: true }] })))).toEqual(['contains_root']);
    expect(await textAt(deps.access, '/ws/a/ro/keep.txt')).toBe('keep');
  });

  it('refuses a recursive delete or move whose contents a deny glob protects (.git, .env)', async () => {
    const deps = memoryDeps({ files: { '/ws/proj/.git/config': 'c', '/ws/proj/.env': 'SECRET=1', '/ws/proj/src/a.ts': 'a', '/ws/plain/x.txt': 'x' }, backupDir: null });
    const deleted = entriesOf(await call({ tool: createFsDelete(deps), items: [{ path: '/ws/proj', recursive: true }, { path: '/ws/plain', recursive: true }] }));
    expect(codes(deleted)).toEqual(['contains_protected', 'ok']);
    expect(deleted[0]?.error).toMatchObject({ category: 'denied', message: expect.stringMatching(/proj\/\.(env|git)/) });
    expect(await textAt(deps.access, '/ws/proj/.env')).toBe('SECRET=1');
    expect(codes(entriesOf(await call({ tool: createFsMove(deps), items: [{ from: '/ws/proj', to: '/ws/proj2' }] })))).toEqual(['contains_protected']);
  });

  it('refuses a move that would put an entry where a deny glob protects it', async () => {
    const deps = memoryDeps({ files: { '/ws/pkg/index.js': 'x' } });
    expect(codes(entriesOf(await call({ tool: createFsMove(deps), items: [{ from: '/ws/pkg', to: '/ws/node_modules' }] })))).toEqual(['denied_glob']);
  });

  it('refuses a move whose contents would land on paths a deny glob protects', async () => {
    const deps = memoryDeps({ files: { '/ws/src/a.js': 'a' }, policy: { denyGlobs: ['build/**/*.js'] } });
    const [entry] = entriesOf(await call({ tool: createFsMove(deps), items: [{ from: '/ws/src', to: '/ws/build/src' }] }));
    expect(entry?.error).toMatchObject({ code: 'contains_protected', message: expect.stringContaining('build/src/a.js') });
  });

  it('fails closed when the directory is too large to check', async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_unused, index) => [`/ws/big/f${index}.txt`, 'x']));
    const deps = memoryDeps({ files, policy: { maxFiles: 10 } });
    expect(codes(entriesOf(await call({ tool: createFsDelete(deps), items: [{ path: '/ws/big', recursive: true }] })))).toEqual(['too_many_entries']);
  });
});
