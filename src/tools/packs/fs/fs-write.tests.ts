import { describe, expect, it } from 'vitest';
import { createFsWrite } from './fs-write.js';
import { call, CONTEXT, entriesOf, memoryDeps, textAt } from './fs-tools.test-support.js';

const undoContext = { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c1', effectId: 'e1', signal: new AbortController().signal };

describe('fs_write', () => {
  it('creates files, refuses to overwrite unless asked, and fails per item', async () => {
    const deps = memoryDeps({ files: { '/ws/old.txt': 'old' } });
    const tool = createFsWrite(deps);
    const entries = entriesOf(await call({ tool, items: [
      { path: '/ws/new.txt', content: 'new' }, { path: '/ws/old.txt', content: 'x' }, { path: '/ws/deep/n.txt', content: 'n' },
      { path: '/ws/deep/n.txt', content: 'n', createDirs: true }, { path: '/docs/x.txt', content: 'x' }, { path: '/elsewhere/x.txt', content: 'x' },
    ] }));
    expect(entries.map(({ ok, error }) => (ok ? 'ok' : error?.code))).toEqual(['ok', 'already_exists', 'not_found', 'ok', 'permission_denied', 'outside_roots']);
    expect(entries[0]?.result).toMatchObject({ path: '/ws/new.txt', bytes: 3, created: true });
    expect(await textAt(deps.access, '/ws/old.txt')).toBe('old');
    expect(await textAt(deps.access, '/ws/deep/n.txt')).toBe('n');
  });

  it('overwrites with overwrite: true, and undo restores the prior content and removes created files', async () => {
    const deps = memoryDeps({ files: { '/ws/old.txt': 'old' } });
    const tool = createFsWrite(deps);
    const executed = await call({ tool, items: [{ path: '/ws/old.txt', content: 'replaced', overwrite: true }, { path: '/ws/made.txt', content: 'made' }] });
    expect(await textAt(deps.access, '/ws/old.txt')).toBe('replaced');
    const [effect] = executed.effects ?? [];
    expect(effect?.descriptor).toBeDefined();
    expect(await tool.applyUndo?.(effect!.descriptor!, undoContext)).toEqual({ ok: true });
    expect(await textAt(deps.access, '/ws/old.txt')).toBe('old');
    await expect(deps.access.stat('/ws/made.txt')).rejects.toMatchObject({ details: { fsCode: 'ENOENT' } });
  });

  it('reports a partial undo: a file changed since is left alone, and without backups an overwrite cannot be undone', async () => {
    const deps = memoryDeps({ files: { '/ws/old.txt': 'old' }, backupDir: null });
    const tool = createFsWrite(deps);
    const executed = await call({ tool, items: [{ path: '/ws/old.txt', content: 'v2', overwrite: true }, { path: '/ws/made.txt', content: 'made' }] });
    await deps.access.writeFile({ path: '/ws/made.txt', data: new TextEncoder().encode('changed by someone') });
    const outcome = await tool.applyUndo?.(executed.effects![0]!.descriptor!, undoContext);
    expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/old\.txt.*no backup|changed/s) });
    expect(await textAt(deps.access, '/ws/made.txt')).toBe('changed by someone');
  });

  it('plans without writing in a dry run, with a diff summary', async () => {
    const deps = memoryDeps({ files: { '/ws/old.txt': 'a\nb\n' } });
    const executed = await call({ tool: createFsWrite(deps), items: [{ path: '/ws/old.txt', content: 'a\nc\nd\n', overwrite: true }], context: { dryRun: true } });
    expect(await textAt(deps.access, '/ws/old.txt')).toBe('a\nb\n');
    expect(executed.plannedEffects).toEqual([expect.objectContaining({ kind: 'file.write', target: '/ws/old.txt', summary: expect.stringContaining('+2 -1'), before: 'a\nb\n', after: 'a\nc\nd\n', reversible: true })]);
  });

  it('verifies an interrupted write by content hash', async () => {
    const deps = memoryDeps({ files: { '/ws/v.txt': 'final' } });
    const tool = createFsWrite(deps);
    expect(await tool.verify?.({ items: [{ path: '/ws/v.txt', content: 'final' }] }, CONTEXT)).toMatchObject({ done: true });
    expect(await tool.verify?.({ items: [{ path: '/ws/v.txt', content: 'other' }] }, CONTEXT)).toMatchObject({ done: false });
  });

  it('refuses a write through a symlink that points outside the roots', async () => {
    const deps = memoryDeps({ files: { '/ws/link.txt': { symlink: '/elsewhere/target.txt' }, '/elsewhere/target.txt': 'safe' } });
    const [entry] = entriesOf(await call({ tool: createFsWrite(deps), items: [{ path: '/ws/link.txt', content: 'pwned', overwrite: true }] }));
    expect(entry).toMatchObject({ ok: false, error: { category: 'denied', code: 'outside_roots' } });
    expect(await textAt(deps.access, '/elsewhere/target.txt')).toBe('safe');
  });

  it('asks for approval per the approvals option and the policy', () => {
    expect(createFsWrite(memoryDeps({ approvals: 'writes' })).requiresApproval).toBeTypeOf('function');
    const writes = createFsWrite(memoryDeps({ approvals: 'writes' }));
    const none = createFsWrite(memoryDeps({ approvals: 'none' }));
    const byPolicy = createFsWrite(memoryDeps({ approvals: 'none', policy: { approval: ({ path }) => path.endsWith('.prod') } }));
    const ask = (tool: typeof writes, path: string) => (tool.requiresApproval as (args: unknown, context: unknown) => boolean)({ items: [{ path, content: 'x' }] }, CONTEXT);
    expect([ask(writes, 'a'), ask(none, 'a'), ask(byPolicy, 'a'), ask(byPolicy, 'cfg.prod')]).toEqual([true, false, false, true]);
  });
});
