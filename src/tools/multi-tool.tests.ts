import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, toolFailure } from './define-tool.js';
import { createMultiTool } from './multi-tool.js';
import { createToolRegistry } from './tool-registry.js';
import type { ToolContext } from './tool-types.js';

const CONTEXT: ToolContext = { agentName: 'a', instanceId: 'i', runId: 'r', signal: new AbortController().signal };

describe('aigent_multi', () => {
  const echo = defineTool({ name: 'echo', description: 'echo', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 'e' }), run: async args => args.text });
  const fail = defineTool({ name: 'fail', description: 'fail', args: z.object({}).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 'f' }), run: async () => { throw toolFailure({ code: 'x', message: 'failed' }); } });

  it('runs mixed calls, returning one envelope each without aborting siblings', async () => {
    const registry = createToolRegistry([echo, fail]);
    const multi = createMultiTool(registry);
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

  it('has a strict schema and requires unique ids', () => {
    const multi = createMultiTool(createToolRegistry([echo]));
    expect(multi.jsonSchema).toMatchObject({ required: ['calls'] });
    expect(multi.argsSchema.safeParse({ calls: [{ id: 'a', tool: 'echo', argsJson: '{}' }, { id: 'a', tool: 'echo', argsJson: '{}' }] }).success).toBe(false);
  });
});
