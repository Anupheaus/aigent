import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createFsEdit } from './fs-edit.js';
import { call, CONTEXT, entriesOf, memoryDeps, textAt } from './fs-tools.test-support.js';

const utf16 = (text: string, order: 'le' | 'be'): Uint8Array => {
  const little = Buffer.from(`﻿${text}`, 'utf16le');
  return order === 'le' ? new Uint8Array(little) : new Uint8Array(Buffer.from(little).swap16());
};
const bytesOf = async (deps: ReturnType<typeof memoryDeps>, path: string): Promise<number[]> => [...await deps.access.readFile(path)];
const edit = (path: string, oldText: string, newText: string) => ({ path, edits: [{ oldText, newText }] });

describe('fs_edit keeps every byte it does not edit (I5)', () => {
  it.each(['le', 'be'] as const)('keeps UTF-16%s with its BOM', async order => {
    const deps = memoryDeps({ files: { '/ws/u.txt': utf16('hello world\r\nsecond\r\n', order) } });
    const [entry] = entriesOf(await call({ tool: createFsEdit(deps), items: [edit('/ws/u.txt', 'hello', 'bye')] }));
    expect(entry?.ok).toBe(true);
    expect(await bytesOf(deps, '/ws/u.txt')).toEqual([...utf16('bye world\r\nsecond\r\n', order)]);
  });

  it('refuses a file with invalid UTF-8 anywhere (past the binary sample too), changing nothing', async () => {
    const original = new Uint8Array([...new TextEncoder().encode(`edit me\n${'x'.repeat(9_000)}\n`), 0xff, 0xfe, 0x80, 0x0a]);
    const deps = memoryDeps({ files: { '/ws/bad.txt': original } });
    const [entry] = entriesOf(await call({ tool: createFsEdit(deps), items: [edit('/ws/bad.txt', 'edit me', 'edited')] }));
    expect(entry?.error).toMatchObject({ code: 'invalid_encoding' });
    expect(await bytesOf(deps, '/ws/bad.txt')).toEqual([...original]);
  });

  it('keeps lone CRs and mixed line endings outside the edit', async () => {
    const deps = memoryDeps({ files: { '/ws/cr.txt': 'a\r\r\nb\r\nc\r\n', '/ws/mixed.txt': 'a\r\nb\nc\r\nd\re\r\n' } });
    await call({ tool: createFsEdit(deps), items: [edit('/ws/cr.txt', 'c', 'C'), edit('/ws/mixed.txt', 'b\nc', 'B\nC')] });
    expect(await textAt(deps.access, '/ws/cr.txt')).toBe('a\r\r\nb\r\nC\r\n');
    // Line breaks the edit replaced take the file's usual ending (CRLF here); every other byte is as it was.
    expect(await textAt(deps.access, '/ws/mixed.txt')).toBe('a\r\nB\r\nC\r\nd\re\r\n');
  });

  it('property: replacing a unique marker changes exactly those bytes, whatever the line endings', async () => {
    const line = fc.array(fc.constantFrom('x', 'y', ' ', 'é', '😀'), { maxLength: 6 }).map(chars => chars.join(''));
    const ending = fc.constantFrom('\n', '\r\n', '\r', '\r\r\n');
    await fc.assert(fc.asyncProperty(fc.array(fc.tuple(line, ending), { maxLength: 8 }), fc.nat(8), fc.boolean(), async (lines, at, hasBom) => {
      const pieces = lines.map(([text, end]) => text + end);
      pieces.splice(Math.min(at, pieces.length), 0, 'MARK');
      const original = (hasBom ? '﻿' : '') + pieces.join('');
      const deps = memoryDeps({ files: { '/ws/p.txt': original } });
      const [entry] = entriesOf(await call({ tool: createFsEdit(deps), items: [edit('/ws/p.txt', 'MARK', 'DONE')] }));
      expect(entry?.ok).toBe(true);
      expect(await textAt(deps.access, '/ws/p.txt')).toBe(original.replace('MARK', 'DONE'));
    }), { numRuns: 200 });
  });
});

describe('fs_edit applies all items for one file together (I7)', () => {
  it('applies none of a file\'s items when one of them fails, and says why for each', async () => {
    const deps = memoryDeps({ files: { '/ws/f.txt': 'hello\n', '/ws/g.txt': 'other\n' } });
    const entries = entriesOf(await call({ tool: createFsEdit(deps), items: [edit('/ws/f.txt', 'hello', 'bye'), edit('/ws/g.txt', 'other', 'OTHER'), edit('f.txt', 'absent', 'x')] }));
    expect(entries.map(({ ok, error }) => (ok ? 'ok' : error?.code))).toEqual(['not_applied', 'ok', 'no_match']);
    expect(entries[0]?.error).toMatchObject({ message: expect.stringContaining('item 3') });
    expect(await textAt(deps.access, '/ws/f.txt')).toBe('hello\n');
    expect(await textAt(deps.access, '/ws/g.txt')).toBe('OTHER\n');
  });

  it('verifies a resumed call with several items on one path against all of them', async () => {
    const deps = memoryDeps({ files: { '/ws/f.txt': 'one two\n' } });
    const tool = createFsEdit(deps);
    const items = [edit('/ws/f.txt', 'one', '1'), edit('./f.txt', 'two', '2')];
    expect(await tool.verify?.({ items }, CONTEXT)).toMatchObject({ done: false });
    await call({ tool, items });
    expect(await textAt(deps.access, '/ws/f.txt')).toBe('1 2\n');
    expect(await tool.verify?.({ items }, CONTEXT)).toMatchObject({ done: true });
  });

  it('plans later items on top of earlier ones for the same file in a dry run', async () => {
    const deps = memoryDeps({ files: { '/ws/f.txt': 'one\n' } });
    const planned = await call({ tool: createFsEdit(deps), items: [edit('/ws/f.txt', 'one', 'two'), edit('/ws/f.txt', 'two', 'three')], context: { dryRun: true } });
    expect(planned.plannedEffects).toEqual([expect.objectContaining({ kind: 'file.edit', target: '/ws/f.txt', before: 'one\n', after: 'three\n' })]);
    expect(await textAt(deps.access, '/ws/f.txt')).toBe('one\n');
  });
});
