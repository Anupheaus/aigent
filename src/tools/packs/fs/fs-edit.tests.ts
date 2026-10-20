import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeFsAccess } from '../../../security/fs-access-node.js';
import { createFsPolicy } from '../../../security/fs-policy.js';
import { tempRoot } from '../../../security/temp-dir.test-support.js';
import { createFsEdit } from './fs-edit.js';
import { call, CONTEXT, entriesOf, memoryDeps, textAt } from './fs-tools.test-support.js';

const undoContext = { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c1', effectId: 'e1', signal: new AbortController().signal };

describe('fs_edit', () => {
  it('applies every edit of an item, counting replacements', async () => {
    const deps = memoryDeps({ files: { '/ws/a.ts': 'const a = 1;\nconst b = 2;\nlet c = a;\n' } });
    const [entry] = entriesOf(await call({ tool: createFsEdit(deps), items: [{ path: '/ws/a.ts', edits: [{ oldText: 'const b = 2;', newText: 'const b = 3;' }, { oldText: 'a', newText: 'x', replaceAll: true }] }] }));
    expect(entry?.result).toMatchObject({ path: '/ws/a.ts', replacements: 3 });
    expect(await textAt(deps.access, '/ws/a.ts')).toBe('const x = 1;\nconst b = 3;\nlet c = x;\n');
  });

  it('fails closed: an ambiguous or absent oldText changes nothing in that file, and other items still apply', async () => {
    const deps = memoryDeps({ files: { '/ws/a.ts': 'x = 1;\nx = 1;\n', '/ws/b.ts': 'keep\n', '/ws/c.ts': 'old\n' } });
    const entries = entriesOf(await call({ tool: createFsEdit(deps), items: [
      { path: '/ws/a.ts', edits: [{ oldText: 'x = 1;', newText: 'x = 2;' }] },
      { path: '/ws/b.ts', edits: [{ oldText: 'keep', newText: 'changed' }, { oldText: 'missing', newText: 'y' }] },
      { path: '/ws/c.ts', edits: [{ oldText: 'old', newText: 'new' }] },
    ] }));
    expect(entries.map(({ ok, error }) => (ok ? 'ok' : error?.code))).toEqual(['ambiguous_match', 'no_match', 'ok']);
    expect(await textAt(deps.access, '/ws/a.ts')).toBe('x = 1;\nx = 1;\n');
    expect(await textAt(deps.access, '/ws/b.ts')).toBe('keep\n');
    expect(await textAt(deps.access, '/ws/c.ts')).toBe('new\n');
  });

  it('applies two items on one file in order, and undo restores the original', async () => {
    const deps = memoryDeps({ files: { '/ws/a.ts': 'one two\n' } });
    const tool = createFsEdit(deps);
    const executed = await call({ tool, items: [{ path: '/ws/a.ts', edits: [{ oldText: 'one', newText: '1' }] }, { path: 'a.ts', edits: [{ oldText: 'two', newText: '2' }] }] });
    expect(await textAt(deps.access, '/ws/a.ts')).toBe('1 2\n');
    expect(await tool.applyUndo?.(executed.effects![0]!.descriptor!, undoContext)).toEqual({ ok: true });
    expect(await textAt(deps.access, '/ws/a.ts')).toBe('one two\n');
  });

  it('keeps CRLF and BOM: what fs_read showed (LF, no BOM) matches, and the file keeps its own line endings', async () => {
    const { root, cleanup } = await tempRoot();
    try {
      await writeFile(join(root, 'w.txt'), Buffer.from('﻿a\r\nb\r\n', 'utf8'));
      const deps = { policy: createFsPolicy({ roots: [{ path: root, permissions: ['read', 'write'] }] }), access: createNodeFsAccess(), approvals: 'none' as const, clock: { now: () => 1 } };
      const [entry] = entriesOf(await call({ tool: createFsEdit(deps), items: [{ path: join(root, 'w.txt'), edits: [{ oldText: 'a\nb', newText: 'a\nB\nc' }] }] }));
      expect(entry?.ok).toBe(true);
      expect(await textAt(deps.access, join(root, 'w.txt'))).toBe('﻿a\r\nB\r\nc\r\n');
    } finally { await cleanup(); }
  });

  it('shows a diff in a dry run without changing the file, and verifies an interrupted edit from its backup', async () => {
    const deps = memoryDeps({ files: { '/ws/a.ts': 'one\n' } });
    const tool = createFsEdit(deps);
    const planned = await call({ tool, items: [{ path: '/ws/a.ts', edits: [{ oldText: 'one', newText: 'two' }] }], context: { dryRun: true } });
    expect(planned.plannedEffects).toEqual([expect.objectContaining({ kind: 'file.edit', target: '/ws/a.ts', before: 'one\n', after: 'two\n', summary: expect.stringContaining('+1 -1') })]);
    expect(await textAt(deps.access, '/ws/a.ts')).toBe('one\n');
    const args = { items: [{ path: '/ws/a.ts', edits: [{ oldText: 'one', newText: 'two' }] }] };
    expect(await tool.verify?.(args, CONTEXT)).toMatchObject({ done: false });
    await call({ tool, items: args.items });
    expect(await tool.verify?.(args, CONTEXT)).toMatchObject({ done: true });
  });
});
