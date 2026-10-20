import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool.js';
import { defineBatchTool } from './define-batch-tool.js';
import { toolFailure } from './tool-failure.js';
import { executeToolCall } from './execute-tool-call.js';
import { createMultiTool } from './multi-tool.js';
import { createToolRegistry } from './tool-registry.js';
import type { InnerCall, MultiToolContext, ToolContext } from './tool-types.js';
import type { ExecutedToolCall } from './execute-tool-call.js';
import { rejectToolCall } from './execute-tool-call.js';

const CONTEXT: ToolContext = { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'm', signal: new AbortController().signal };
const now = (): number => 0;

/** A run's dispatcher as `aigent_multi` sees it: records each inner call it is handed, and runs it (or refuses it). */
function dispatchingContext(params: { handed: string[]; run(call: InnerCall): Promise<ExecutedToolCall> }): MultiToolContext {
  const { handed, run } = params;
  return { ...CONTEXT, runInnerCall: call => { handed.push(`${call.id}:${call.tool}:${JSON.stringify(call.args)}`); return run(call); } };
}

describe('aigent_multi', () => {
  const echo = defineTool({ name: 'echo', description: 'echo', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 'e' }), run: async args => args.text });
  const fail = defineTool({ name: 'fail', description: 'fail', args: z.object({}).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 'f' }), run: async () => { throw toolFailure({ code: 'x', message: 'failed' }); } });

  it('runs mixed calls, returning one envelope each without aborting siblings', async () => {
    const registry = createToolRegistry([echo, fail]);
    const multi = createMultiTool({ registry, now });
    const result = await multi.run({ calls: [
      { id: 'a', tool: 'echo', args: { text: 'hi' } },
      { id: 'b', tool: 'fail', args: {} },
      { id: 'c', tool: 'echo', args: { text: 5 } },
      { id: 'd', tool: 'aigent_multi', args: {} },
    ] }, CONTEXT);
    expect(result).toEqual([
      { id: 'a', tool: 'echo', ok: true, result: 'hi' },
      expect.objectContaining({ id: 'b', ok: false, error: expect.objectContaining({ code: 'x' }) }),
      expect.objectContaining({ id: 'c', ok: false, error: expect.objectContaining({ category: 'validation' }) }),
      expect.objectContaining({ id: 'd', ok: false, error: expect.objectContaining({ category: 'denied' }) }),
    ]);
    expect(multi.summarise?.(result)).toEqual({ success: false, reason: '3 of 4 calls failed' });
  });

  // The run budget, approvals, the ledger and guardrails belong to the dispatcher (see core/multi-dispatch.tests.ts):
  // in a run, aigent_multi hands every inner call to it and returns what it produced.
  it('hands every inner call to the run dispatcher in call order and returns its results', async () => {
    const handed: string[] = [];
    const registry = createToolRegistry([echo]);
    const multi = createMultiTool({ registry, now });
    const run = async (call: InnerCall): Promise<ExecutedToolCall> => (call.id === 'b'
      ? rejectToolCall({ call: { id: call.id, name: call.tool, args: call.args }, error: { category: 'denied', code: 'tool_call_limit', retryable: false, message: 'limit' } })
      : executeToolCall({ registry, call: { id: call.id, name: call.tool, args: call.args }, context: CONTEXT, now }));
    const result = await multi.run({ calls: [{ id: 'a', tool: 'echo', args: { text: 'x' } }, { id: 'b', tool: 'echo', args: { text: 'y' } }] }, dispatchingContext({ handed, run }));
    expect(handed).toEqual(['a:echo:{"text":"x"}', 'b:echo:{"text":"y"}']);
    expect(result).toEqual([
      { id: 'a', tool: 'echo', ok: true, result: 'x' },
      expect.objectContaining({ id: 'b', ok: false, error: expect.objectContaining({ code: 'tool_call_limit' }) }),
    ]);
  });

  it('gives inner tools the public context when used directly', async () => {
    let seenContext: ToolContext | undefined;
    const spy = defineTool({ name: 'spy', description: 'spy', args: z.object({}).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 's' }), run: async (_args, context) => { seenContext = context; return 1; } });
    const multi = createMultiTool({ registry: createToolRegistry([spy]), now });
    await multi.run({ calls: [{ id: 'a', tool: 'spy', args: {} }] }, CONTEXT);
    expect(seenContext).toEqual({ ...CONTEXT, callId: 'a' });
  });

  it('reports inner failures, including failed items of inner batch tools, as nested failures', async () => {
    const batch = defineBatchTool({ name: 'batch', description: 'b', item: z.object({ id: z.string() }).strict(), maxItems: 3, deterministic: true, cache: false, describeActivity: () => ({ title: 'b' }), runItem: async batchItem => { if (batchItem.id === 'bad') throw new Error('bad item'); return batchItem.id; } });
    const multi = createMultiTool({ registry: createToolRegistry([echo, fail, batch]), now });
    const result = await multi.run({ calls: [
      { id: 'a', tool: 'echo', args: { text: 'hi' } },
      { id: 'b', tool: 'fail', args: {} },
      { id: 'c', tool: 'batch', args: { items: [{ id: 'ok' }, { id: 'bad' }] } },
    ] }, CONTEXT);
    expect(multi.nestedFailures?.(result)).toEqual([
      expect.objectContaining({ code: 'x', details: { callId: 'b', tool: 'fail' } }),
      expect.objectContaining({ code: 'tool_threw', message: 'bad item', details: { itemIndex: 1, callId: 'c', tool: 'batch' } }),
    ]);
  });

  it('requires unique ids', () => {
    const multi = createMultiTool({ registry: createToolRegistry([echo]), now });
    expect(multi.jsonSchema).toMatchObject({ required: ['calls'] });
    expect(multi.argsSchema.safeParse({ calls: [{ id: 'a', tool: 'echo', args: {} }, { id: 'a', tool: 'echo', args: {} }] }).success).toBe(false);
  });

  // The one deliberately non-strict tool: a strict schema cannot describe every inner tool's arguments.
  it('is the non-strict tool whose calls are { id, tool, args } with args a free-form object', () => {
    const multi = createMultiTool({ registry: createToolRegistry([echo]), now });
    expect(multi.strict).toBe(false);
    expect(multi.jsonSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['calls'],
      properties: {
        calls: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'tool', 'args'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 64 },
              tool: { type: 'string', minLength: 1, maxLength: 64 },
              args: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    });
    expect(JSON.stringify(multi.jsonSchema)).not.toContain('argsJson');
  });

  it('rejects args given as a JSON string, missing args and unknown keys on a call', () => {
    const multi = createMultiTool({ registry: createToolRegistry([echo]), now });
    expect(multi.argsSchema.safeParse({ calls: [{ id: 'a', tool: 'echo', args: '{"text":"hi"}' }] }).success).toBe(false);
    expect(multi.argsSchema.safeParse({ calls: [{ id: 'a', tool: 'echo' }] }).success).toBe(false);
    expect(multi.argsSchema.safeParse({ calls: [{ id: 'a', tool: 'echo', args: {}, argsJson: '{}' }] }).success).toBe(false);
  });

  it('passes nested args objects (including nulls for optional keys) through to the inner tool', async () => {
    const nested = defineTool({
      name: 'nested', description: 'n', deterministic: true, cache: false, describeActivity: () => ({ title: 'n' }),
      args: z.object({ filter: z.object({ path: z.string(), depth: z.number().optional() }).strict() }).strict(),
      run: async args => args.filter,
    });
    const multi = createMultiTool({ registry: createToolRegistry([nested]), now });
    const result = await multi.run({ calls: [{ id: 'a', tool: 'nested', args: { filter: { path: 'src', depth: null } } }] }, CONTEXT);
    expect(result).toEqual([{ id: 'a', tool: 'nested', ok: true, result: { path: 'src' } }]);
  });
});

describe('aigent_multi nested results', () => {
  it('keeps failed items of an inner batch tool whose visible result was truncated', async () => {
    const batch = defineBatchTool({ name: 'batch', description: 'b', item: z.object({ id: z.string() }).strict(), maxItems: 3, deterministic: true, cache: false, maxResultTokens: 1, describeActivity: () => ({ title: 'b' }), runItem: async batchItem => { if (batchItem.id === 'bad') throw new Error('bad item'); return batchItem.id.repeat(40); } });
    const multi = createMultiTool({ registry: createToolRegistry([batch]), now });
    const result = await multi.run({ calls: [{ id: 'c', tool: 'batch', args: { items: [{ id: 'ok' }, { id: 'bad' }] } }] }, CONTEXT);
    expect(result).toEqual([expect.objectContaining({ id: 'c', ok: true, result: expect.objectContaining({ truncated: true }) })]);
    expect(multi.nestedFailures?.(result)).toEqual([expect.objectContaining({ message: 'bad item', details: { itemIndex: 1, callId: 'c', tool: 'batch' } })]);
  });
});

describe('aigent_multi timeouts', () => {
  const SLOW_TIMEOUT_MS = 120_000;
  const SLOW_FINISH_MS = 31_000;

  function slowAndFastRegistry() {
    const slow = defineTool({
      name: 'slow', description: 's', args: z.object({}).strict(), deterministic: true, cache: false, timeoutMs: SLOW_TIMEOUT_MS,
      describeActivity: () => ({ title: 's' }), run: () => new Promise(resolve => setTimeout(() => resolve('slow done'), SLOW_FINISH_MS)),
    });
    const fast = defineTool({ name: 'fast', description: 'f', args: z.object({}).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 'f' }), run: async () => 'fast done' });
    const hanging = defineTool({ name: 'hanging', description: 'h', args: z.object({}).strict(), deterministic: true, cache: false, timeoutMs: 50, describeActivity: () => ({ title: 'h' }), run: () => new Promise(() => undefined) });
    return createToolRegistry([slow, fast, hanging]);
  }

  afterEach(() => { vi.useRealTimers(); });

  it('allows at least as long as its slowest inner tool', () => {
    const multi = createMultiTool({ registry: slowAndFastRegistry(), now });
    expect(multi.timeoutMs).toBeGreaterThan(SLOW_TIMEOUT_MS);
  });

  it('does not cut off an inner tool that runs past the 30 s default but within its own timeout', async () => {
    vi.useFakeTimers();
    const multi = createMultiTool({ registry: slowAndFastRegistry(), now });
    const pending = executeToolCall({
      registry: createToolRegistry([multi]),
      call: { id: 'm', name: 'aigent_multi', args: { calls: [{ id: 'a', tool: 'slow', args: {} }, { id: 'b', tool: 'fast', args: {} }] } },
      context: CONTEXT, now,
    });
    await vi.advanceTimersByTimeAsync(SLOW_FINISH_MS);
    expect((await pending).envelope).toEqual({ id: 'm', tool: 'aigent_multi', ok: true, result: [
      { id: 'a', tool: 'slow', ok: true, result: 'slow done' },
      { id: 'b', tool: 'fast', ok: true, result: 'fast done' },
    ] });
  });

  it('still enforces each inner tool its own timeout without losing the siblings', async () => {
    const multi = createMultiTool({ registry: slowAndFastRegistry(), now });
    const result = await multi.run({ calls: [{ id: 'a', tool: 'hanging', args: {} }, { id: 'b', tool: 'fast', args: {} }] }, CONTEXT);
    expect(result).toEqual([
      expect.objectContaining({ id: 'a', ok: false, error: expect.objectContaining({ category: 'timeout', code: 'tool_timeout' }) }),
      { id: 'b', tool: 'fast', ok: true, result: 'fast done' },
    ]);
  });
});
