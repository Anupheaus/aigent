import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeFsAccess } from '../../../security/fs-access-node.js';
import { createFsPolicy } from '../../../security/fs-policy.js';
import { tempRoot } from '../../../security/temp-dir.test-support.js';
import { createFsRead } from './fs-read.js';
import { call, entriesOf, memoryDeps } from './fs-tools.test-support.js';

const LINES = Array.from({ length: 10 }, (_unused, index) => `line ${index + 1}`).join('\n');

describe('fs_read', () => {
  it('reads files with line numbers and per-item failures', async () => {
    const deps = memoryDeps({ files: { '/ws/a.txt': `${LINES}\n`, '/ws/.env': 'SECRET=1' } });
    const entries = entriesOf(await call({ tool: createFsRead(deps), items: [{ path: '/ws/a.txt', offset: 3, limit: 2 }, { path: '/ws/missing.txt' }, { path: '/etc/passwd' }, { path: '/ws/.env' }] }));
    expect(entries[0]).toEqual({ index: 0, ok: true, result: { path: '/ws/a.txt', text: 'line 3\nline 4\n', startLine: 3, endLine: 4, totalLines: 10, truncated: true, encoding: 'utf-8', bytes: 71 } });
    expect(entries[1]).toMatchObject({ ok: false, error: { code: 'not_found', category: 'thrown' } });
    expect(entries[2]).toMatchObject({ ok: false, error: { category: 'denied', code: 'outside_roots', suggestion: expect.stringContaining('workspace') } });
    expect(entries[3]).toMatchObject({ ok: false, error: { category: 'denied', code: 'denied_glob' } });
  });

  it('reads a whole file exactly, the last line included', async () => {
    const deps = memoryDeps({ files: { '/ws/a.txt': 'one\ntwo' } });
    const [entry] = entriesOf(await call({ tool: createFsRead(deps), items: [{ path: 'a.txt' }] }));
    expect(entry?.result).toMatchObject({ text: 'one\ntwo', startLine: 1, endLine: 2, totalLines: 2, truncated: false });
  });

  it('describes binary files instead of returning their bytes', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const deps = memoryDeps({ files: { '/ws/logo.png': png } });
    const [entry] = entriesOf(await call({ tool: createFsRead(deps), items: [{ path: '/ws/logo.png' }] }));
    expect(entry?.result).toEqual({ path: '/ws/logo.png', binary: true, bytes: 12, mimeGuess: 'image/png' });
  });

  it('cuts very long lines with an explicit marker', async () => {
    const deps = memoryDeps({ files: { '/ws/min.js': `${'x'.repeat(25_000)}\nnext` } });
    const [entry] = entriesOf(await call({ tool: createFsRead(deps), items: [{ path: '/ws/min.js' }] }));
    expect(entry?.result).toMatchObject({ truncated: true, totalLines: 2 });
    expect(String(entry?.result?.text)).toContain('… [line cut: 5000 more characters]');
  });

  it('reads huge files in parts up to maxReadBytes, marking where it stopped', async () => {
    const big = Array.from({ length: 5_000 }, (_unused, index) => `row ${index + 1}`).join('\n');
    const deps = memoryDeps({ files: { '/ws/big.log': big }, policy: { maxReadBytes: 1_000 } });
    const [first] = entriesOf(await call({ tool: createFsRead(deps), items: [{ path: '/ws/big.log', limit: 5_000 }] }));
    expect(first?.result).toMatchObject({ startLine: 1, truncated: true });
    expect(String(first?.result?.text).length).toBeLessThanOrEqual(1_100);
    const [later] = entriesOf(await call({ tool: createFsRead(deps), items: [{ path: '/ws/big.log', offset: 4_000, limit: 2 }] }));
    expect(later?.result).toMatchObject({ text: 'row 4000\nrow 4001\n', startLine: 4_000, endLine: 4_001 });
  });

  it('is byte-faithful in raw mode (BOM and CRLF kept) and normalised otherwise, on a real disk', async () => {
    const { root, cleanup } = await tempRoot();
    try {
      await writeFile(join(root, 'win.txt'), Buffer.from('﻿first\r\nsecond\r\n', 'utf8'));
      const deps = { policy: createFsPolicy({ roots: [{ path: root, permissions: ['read'] }] }), access: createNodeFsAccess(), approvals: 'none' as const, clock: { now: () => 0 } };
      const [raw, plain] = entriesOf(await call({ tool: createFsRead(deps), items: [{ path: join(root, 'win.txt'), raw: true }, { path: join(root, 'win.txt') }] }));
      expect(raw?.result).toMatchObject({ text: '﻿first\r\nsecond\r\n', encoding: 'utf-8-bom', totalLines: 2 });
      expect(plain?.result).toMatchObject({ text: 'first\nsecond\n', encoding: 'utf-8-bom' });
    } finally { await cleanup(); }
  });

  it('declares itself verbatim file content, cached by canonical path and invalidated by mtime and size', async () => {
    const deps = memoryDeps({ files: { '/ws/a.txt': 'one' } });
    const tool = createFsRead(deps);
    expect(tool).toMatchObject({ contentKind: 'file-content', fidelity: 'verbatim', deterministic: false, cache: true, maxResultTokens: 8_000 });
    expect(tool.cacheKey?.({ items: [{ path: '/ws/./sub/../a.txt' }] })).toEqual(tool.cacheKey?.({ items: [{ path: '/ws/a.txt' }] }));
    const before = await tool.validity?.({ items: [{ path: '/ws/a.txt' }] }, { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c', signal: new AbortController().signal });
    await deps.access.writeFile({ path: '/ws/a.txt', data: new TextEncoder().encode('two!') });
    const after = await tool.validity?.({ items: [{ path: '/ws/a.txt' }] }, { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c', signal: new AbortController().signal });
    expect(after).not.toBe(before);
  });
});
