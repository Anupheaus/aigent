import { describe, expect, it } from 'vitest';
import { executeToolCall } from '../../execute-tool-call.js';
import { createToolRegistry } from '../../tool-registry.js';
import type { Tool } from '../../tool-types.js';
import { dataTools } from './index.js';

const CONTEXT = { agentName: 'a', instanceId: 'i', runId: 'r', signal: new AbortController().signal };
const tools = new Map(dataTools().map(tool => [tool.name, tool]));

async function run(params: { name: string; items: unknown[] }) {
  const tool = tools.get(params.name) as Tool;
  const executed = await executeToolCall({ registry: createToolRegistry([tool]), call: { id: 'c', name: params.name, args: { items: params.items } }, context: CONTEXT, now: () => 0 });
  if (!executed.envelope.ok) throw new Error(executed.envelope.error.message);
  return executed.envelope.result as { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } }[];
}

describe('dataTools', () => {
  it('declares deterministic, globally cacheable batch tools', () => {
    expect([...tools.keys()].sort()).toEqual(['calc', 'csv_query', 'json_query', 'regex_extract', 'text_diff']);
    for (const tool of tools.values()) expect(tool).toMatchObject({ deterministic: true, cache: true, sharedCache: true, hasSideEffects: false });
    expect(tools.get('text_diff')).toMatchObject({ contentKind: 'prose', fidelity: 'verbatim' });
    expect(tools.get('csv_query')).toMatchObject({ contentKind: 'structured-data', fidelity: 'lossy-ok' });
    expect(tools.get('json_query')).toMatchObject({ contentKind: 'structured-data', fidelity: 'verbatim' });
  });
});

describe('json_query', () => {
  it('queries inline JSON and reports invalid JSON and queries precisely', async () => {
    const entries = await run({ name: 'json_query', items: [
      { json: '{"a":[{"b":1},{"b":2}]}', query: '$.a[*].b' }, { json: '{"a":', query: '$' }, { json: '{}', query: 'a.b' },
    ] });
    expect(entries[0]?.result).toEqual({ matches: [1, 2], count: 2 });
    expect(entries[1]?.error).toMatchObject({ code: 'invalid_json' });
    expect(entries[2]?.error).toMatchObject({ code: 'invalid_query', message: expect.stringContaining('character 1') });
  });
});

describe('csv_query', () => {
  const csv = 'name,age,city\r\nAnn,31,"Leeds, UK"\r\nBob,25,York\r\n"Cy ""C""",40,Leeds\r\n';
  it('selects, filters, orders and limits rows', async () => {
    const [entry] = await run({ name: 'csv_query', items: [{ csv, select: ['name', 'age'], where: [{ column: 'age', op: 'gt', value: '26' }], orderBy: { column: 'age', direction: 'desc' }, limit: 5 }] });
    expect(entry?.result).toEqual({ columns: ['name', 'age'], rows: [['Cy "C"', '40'], ['Ann', '31']], totalRows: 3, matchedRows: 2, truncated: false });
  });

  it('handles contains, startsWith, no header and unknown columns', async () => {
    const entries = await run({ name: 'csv_query', items: [
      { csv, where: [{ column: 'city', op: 'contains', value: 'Leeds' }] },
      { csv: 'x,1\ny,2\n', header: false, where: [{ column: 'column1', op: 'startsWith', value: 'y' }] },
      { csv, select: ['nope'] },
      { csv: 'a,"b\n' },
    ] });
    expect(entries[0]?.result?.matchedRows).toBe(2);
    expect(entries[1]?.result).toMatchObject({ columns: ['column1', 'column2'], rows: [['y', '2']] });
    expect(entries[2]?.error).toMatchObject({ code: 'unknown_column' });
    expect(entries[3]?.error).toMatchObject({ code: 'unterminated_quote' });
  });
});

describe('text_diff', () => {
  it('returns a unified diff with stats', async () => {
    const [changed, same] = await run({ name: 'text_diff', items: [{ a: 'a\nb\nc\n', b: 'a\nB\nc\n', context: 1 }, { a: 'x', b: 'x' }] });
    expect(changed?.result).toMatchObject({ identical: false, added: 1, removed: 1, unchanged: 2, diff: expect.stringContaining('-b\n+B') });
    expect(same?.result).toMatchObject({ identical: true, diff: '' });
  });

  it('refuses oversized sides and diffs an empty side against many lines quickly', async () => {
    const started = Date.now();
    const many = Array.from({ length: 50_000 }, (_unused, index) => `line ${index}`).join('\n');
    const [fromEmpty, tooLong, tooManyLines] = await run({ name: 'text_diff', items: [
      { a: '', b: many }, { a: 'x'.repeat(1_000_001), b: '' }, { a: '\n'.repeat(100_000), b: '' },
    ] });
    expect(fromEmpty?.result).toMatchObject({ added: 50_000, removed: 0, minimal: true });
    expect(tooLong?.error).toMatchObject({ code: 'input_too_large' });
    expect(tooManyLines?.error).toMatchObject({ code: 'input_too_large' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('regex_extract', () => {
  it('extracts matches with captures and named groups', async () => {
    const [entry] = await run({ name: 'regex_extract', items: [{ text: 'id=1 id=22', pattern: 'id=(?<n>\\d+)', flags: 'g' }] });
    expect(entry?.result).toEqual({ count: 2, truncated: false, matches: [{ match: 'id=1', index: 0, captures: ['1'], groups: { n: '1' } }, { match: 'id=22', index: 5, captures: ['22'], groups: { n: '22' } }] });
  });

  it('refuses pathological patterns quickly and handles large input within its budget', async () => {
    const started = Date.now();
    const [unsafe] = await run({ name: 'regex_extract', items: [{ text: `${'a'.repeat(50)}!`, pattern: '(a+)+$' }] });
    expect(unsafe?.error).toMatchObject({ code: 'unsafe_pattern' });
    const big = 'word 123\n'.repeat(100_000);
    const [large] = await run({ name: 'regex_extract', items: [{ text: big, pattern: '\\d+', maxMatches: 1_000 }] });
    expect(large?.result).toMatchObject({ count: 1_000, truncated: true });
    const [tooBig] = await run({ name: 'regex_extract', items: [{ text: 'x'.repeat(1_000_001), pattern: 'x' }] });
    expect(tooBig?.error).toMatchObject({ code: 'input_too_large' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('calc', () => {
  it('evaluates expressions and reports exact errors', async () => {
    const entries = await run({ name: 'calc', items: [{ expression: '2 * (3 + 4) ^ 2' }, { expression: '1 / 0' }, { expression: 'alert(1)' }] });
    expect(entries[0]?.result).toEqual({ value: 98 });
    expect(entries[1]?.error).toMatchObject({ code: 'division_by_zero' });
    expect(entries[2]?.error).toMatchObject({ code: 'unknown_identifier' });
  });
});
