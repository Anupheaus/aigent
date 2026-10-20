import { describe, expect, it } from 'vitest';
import { createFsDelete } from './fs-delete.js';
import { createFsMove } from './fs-move.js';
import { call, CONTEXT, entriesOf, memoryDeps, textAt } from './fs-tools.test-support.js';

const undoContext = { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c1', effectId: 'e1', signal: new AbortController().signal };
const gone = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ details: { fsCode: 'ENOENT' } });

describe('fs_move', () => {
  it('moves files and directories, refuses to replace unless asked, and undo moves them back', async () => {
    const deps = memoryDeps({ files: { '/ws/a.txt': 'a', '/ws/b.txt': 'b', '/ws/dir/x.txt': 'x', '/docs/r.md': 'r' } });
    const tool = createFsMove(deps);
    const executed = await call({ tool, items: [{ from: '/ws/a.txt', to: '/ws/moved.txt' }, { from: '/ws/dir', to: '/ws/dir2' }, { from: '/ws/b.txt', to: '/ws/moved.txt' }, { from: '/docs/r.md', to: '/ws/r.md' }] });
    expect(entriesOf(executed).map(({ ok, error }) => (ok ? 'ok' : error?.code))).toEqual(['ok', 'ok', 'already_exists', 'permission_denied']);
    expect(await textAt(deps.access, '/ws/dir2/x.txt')).toBe('x');
    expect(await tool.applyUndo?.(executed.effects![0]!.descriptor!, undoContext)).toEqual({ ok: true });
    expect(await textAt(deps.access, '/ws/a.txt')).toBe('a');
    expect(await textAt(deps.access, '/ws/dir/x.txt')).toBe('x');
  });

  it('replaces with overwrite, backing up the replaced file so undo restores both', async () => {
    const deps = memoryDeps({ files: { '/ws/a.txt': 'a', '/ws/b.txt': 'b' } });
    const tool = createFsMove(deps);
    const executed = await call({ tool, items: [{ from: '/ws/a.txt', to: '/ws/b.txt', overwrite: true }] });
    expect(await textAt(deps.access, '/ws/b.txt')).toBe('a');
    expect(await tool.applyUndo?.(executed.effects![0]!.descriptor!, undoContext)).toEqual({ ok: true });
    expect([await textAt(deps.access, '/ws/a.txt'), await textAt(deps.access, '/ws/b.txt')]).toEqual(['a', 'b']);
  });

  it('verifies an interrupted move by where things are', async () => {
    const deps = memoryDeps({ files: { '/ws/b.txt': 'a' } });
    expect(await createFsMove(deps).verify?.({ items: [{ from: '/ws/a.txt', to: '/ws/b.txt' }] }, CONTEXT)).toMatchObject({ done: true });
    expect(await createFsMove(deps).verify?.({ items: [{ from: '/ws/b.txt', to: '/ws/c.txt' }] }, CONTEXT)).toMatchObject({ done: false });
  });
});

describe('fs_delete', () => {
  it('moves deletes into the managed trash so undo restores them, and needs recursive for directories', async () => {
    const deps = memoryDeps({ files: { '/ws/a.txt': 'a', '/ws/dir/x.txt': 'x' } });
    const tool = createFsDelete(deps);
    const executed = await call({ tool, items: [{ path: '/ws/a.txt' }, { path: '/ws/dir' }, { path: '/ws/dir', recursive: true }, { path: '/ws' }] });
    expect(entriesOf(executed).map(({ ok, error }) => (ok ? 'ok' : error?.code))).toEqual(['ok', 'is_a_directory', 'ok', 'root_protected']);
    await gone(deps.access.stat('/ws/a.txt'));
    expect(await tool.applyUndo?.(executed.effects![0]!.descriptor!, undoContext)).toEqual({ ok: true });
    expect(await textAt(deps.access, '/ws/a.txt')).toBe('a');
    expect(await textAt(deps.access, '/ws/dir/x.txt')).toBe('x');
  });

  it('deletes for good without a backupDir, and then cannot be undone', async () => {
    const deps = memoryDeps({ files: { '/ws/a.txt': 'a' }, backupDir: null });
    const executed = await call({ tool: createFsDelete(deps), items: [{ path: '/ws/a.txt' }] });
    await gone(deps.access.stat('/ws/a.txt'));
    expect(await createFsDelete(deps).applyUndo?.(executed.effects![0]!.descriptor!, undoContext)).toMatchObject({ ok: false, message: expect.stringContaining('backupDir') });
  });

  it('requires approval by default and plans without deleting in a dry run', async () => {
    const deps = memoryDeps({ files: { '/ws/a.txt': 'a' }, approvals: 'deletes' });
    const tool = createFsDelete(deps);
    expect((tool.requiresApproval as (args: unknown, context: unknown) => boolean)({ items: [{ path: '/ws/a.txt' }] }, CONTEXT)).toBe(true);
    expect(tool.risk).toBe('high');
    const planned = await call({ tool, items: [{ path: '/ws/a.txt' }], context: { dryRun: true } });
    expect(planned.plannedEffects).toEqual([expect.objectContaining({ kind: 'file.delete', target: '/ws/a.txt', reversible: true })]);
    expect(await textAt(deps.access, '/ws/a.txt')).toBe('a');
  });
});
