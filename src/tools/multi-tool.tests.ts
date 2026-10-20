import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineBatchTool, defineTool, toolFailure } from './define-tool.js';
import { createMultiTool } from './multi-tool.js';
import { createToolRegistry } from './tool-registry.js';
import type { MultiToolContext, ToolContext } from './tool-types.js';

const CONTEXT: ToolContext = { agentName: 'a', instanceId: 'i', runId: 'r', signal: new AbortController().signal };
const now = (): number => 0;

function contextWithBudget(budget: number): MultiToolContext {
  let remaining = budget;
  return { ...CONTEXT, reserveToolCall: () => { if (remaining === 0) return false; remaining -= 1; return true; } };
}

describe('aigent_multi', () => {
  const echo = defineTool({ name: 'echo', description: 'echo', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 'e' }), run: async args => args.text });
  const fail = defineTool({ name: 'fail', description: 'fail', args: z.object({}).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 'f' }), run: async () => { throw toolFailure({ code: 'x', message: 'failed' }); } });

  it('runs mixed calls, returning one envelope each without aborting siblings', async () => {
    const registry = createToolRegistry([echo, fail]);
    const multi = createMultiTool({ registry, now });
    const result = await multi.run({ calls: [
      { id: 'a', tool: 'echo', argsJson: '{"text":"hi"}' },
      { id: 'b', tool: 'fail', argsJson: '{}' },
      { id: 'c', tool: 'echo', argsJson: 'not json' },
      { id: 'd', tool: 'aigent_multi', argsJson: '{}' },
    ] }, CONTEXT);
    expect(result).toEqual([
      { id: 'a', tool: 'echo', ok: true, result: 'hi' },
      expect.objectContaining({ id: 'b', ok: false, error: expect.objectContaining({ code: 'x' }) }),
      expect.objectContaining({ id: 'c', ok: false, error: expect.objectContaining({ category: 'validation' }) }),
      expect.objectContaining({ id: 'd', ok: false, error: expect.objectContaining({ category: 'denied' }) }),
    ]);
    expect(multi.summarise?.(result)).toEqual({ success: false, reason: '3 of 4 calls failed' });
  });

  it('takes each inner call from the run budget and refuses calls past it with tool_call_limit', async () => {
    let echoRuns = 0;
    const counted = defineTool({ name: 'echo', description: 'echo', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 'e' }), run: async args => { echoRuns += 1; return args.text; } });
    const multi = createMultiTool({ registry: createToolRegistry([counted]), now });
    const calls = ['a', 'b', 'c'].map(id => ({ id, tool: 'echo', argsJson: '{"text":"x"}' }));
    const result = await multi.run({ calls }, contextWithBudget(2));
    expect(echoRuns).toBe(2);
    expect(result).toEqual([
      { id: 'a', tool: 'echo', ok: true, result: 'x' },
      { id: 'b', tool: 'echo', ok: true, result: 'x' },
      expect.objectContaining({ id: 'c', ok: false, error: expect.objectContaining({ category: 'denied', code: 'tool_call_limit' }) }),
    ]);
  });

  it('does not pass the run budget on to the inner tools', async () => {
    let seenContext: ToolContext | undefined;
    const spy = defineTool({ name: 'spy', description: 'spy', args: z.object({}).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 's' }), run: async (_args, context) => { seenContext = context; return 1; } });
    const multi = createMultiTool({ registry: createToolRegistry([spy]), now });
    await multi.run({ calls: [{ id: 'a', tool: 'spy', argsJson: '{}' }] }, contextWithBudget(1));
    expect(seenContext).toEqual(CONTEXT);
  });

  it('reports inner failures, including failed items of inner batch tools, as nested failures', async () => {
    const batch = defineBatchTool({ name: 'batch', description: 'b', item: z.object({ id: z.string() }).strict(), maxItems: 3, deterministic: true, cache: false, describeActivity: () => ({ title: 'b' }), runItem: async batchItem => { if (batchItem.id === 'bad') throw new Error('bad item'); return batchItem.id; } });
    const multi = createMultiTool({ registry: createToolRegistry([echo, fail, batch]), now });
    const result = await multi.run({ calls: [
      { id: 'a', tool: 'echo', argsJson: '{"text":"hi"}' },
      { id: 'b', tool: 'fail', argsJson: '{}' },
      { id: 'c', tool: 'batch', argsJson: '{"items":[{"id":"ok"},{"id":"bad"}]}' },
    ] }, CONTEXT);
    expect(multi.nestedFailures?.(result)).toEqual([
      expect.objectContaining({ code: 'x', details: { callId: 'b', tool: 'fail' } }),
      expect.objectContaining({ code: 'tool_threw', message: 'bad item', details: { itemIndex: 1, callId: 'c', tool: 'batch' } }),
    ]);
  });

  it('has a strict schema and requires unique ids', () => {
    const multi = createMultiTool({ registry: createToolRegistry([echo]), now });
    expect(multi.jsonSchema).toMatchObject({ required: ['calls'] });
    expect(multi.argsSchema.safeParse({ calls: [{ id: 'a', tool: 'echo', argsJson: '{}' }, { id: 'a', tool: 'echo', argsJson: '{}' }] }).success).toBe(false);
  });
});
