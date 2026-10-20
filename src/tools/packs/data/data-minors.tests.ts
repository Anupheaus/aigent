import { describe, expect, it } from 'vitest';
import { globRegExp } from '../../../security/glob.js';
import { executeToolCall } from '../../execute-tool-call.js';
import { createToolRegistry } from '../../tool-registry.js';
import type { Tool } from '../../tool-types.js';
import { queryJsonPath } from '../json-path.js';
import { dataTools } from './index.js';

const CONTEXT = { agentName: 'a', instanceId: 'i', runId: 'r', signal: new AbortController().signal };
const tools = new Map(dataTools().map(tool => [tool.name, tool]));

async function run(params: { name: string; items: unknown[] }) {
  const tool = tools.get(params.name) as Tool;
  const executed = await executeToolCall({ registry: createToolRegistry([tool]), call: { id: 'c', name: params.name, args: { items: params.items } }, context: CONTEXT, now: () => 0 });
  if (!executed.envelope.ok) throw new Error(executed.envelope.error.message);
  return executed.envelope.result as { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } }[];
}

describe('data pack minor fixes', () => {
  it('reports an invalid glob class as a structured error, not a raw SyntaxError', () => {
    expect(() => globRegExp({ pattern: '[z-a]' })).toThrow(expect.objectContaining({ code: 'invalid_input', details: expect.objectContaining({ reason: 'invalid_glob' }) }));
  });

  it('json_query: deep documents do not overflow the stack, and runaway descents are capped', () => {
    let deep: unknown = 1;
    for (let level = 0; level < 20_000; level += 1) deep = [deep];
    expect(queryJsonPath({ document: deep as never, query: '$..*' }).length).toBe(20_000);
    let wide: unknown = 0;
    for (let level = 0; level < 800; level += 1) wide = { a: wide, b: level };
    expect(() => queryJsonPath({ document: wide as never, query: '$..*..*' })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'too_many_results' }) }));
  });

  it('csv_query: decimal numbers only, a total order, extra cells reported and trailing blank lines ignored', async () => {
    const [hex, mixed, wide] = await run({ name: 'csv_query', items: [
      { csv: 'v\n0x10\n16\n', where: [{ column: 'v', op: 'eq', value: '16' }] },
      { csv: 'v\nb\n10\na\n9\n\n', orderBy: { column: 'v' } },
      { csv: 'a,b\n1,2,SECRET\n3,4\n' },
    ] });
    expect(hex?.result).toMatchObject({ rows: [['16']] });
    expect(mixed?.result).toMatchObject({ rows: [['9'], ['10'], ['a'], ['b']], totalRows: 4 });
    expect(wide?.result).toMatchObject({ extraCells: { rows: 1, cells: 1 } });
  });

  it('describes calc as floating point and states json_query\'s unsupported syntax', () => {
    expect(tools.get('calc')?.description).not.toContain('exactly');
    expect(tools.get('calc')?.description).toContain('floating point');
    expect(tools.get('json_query')?.description).toContain('Not supported');
  });
});
