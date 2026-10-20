import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineBatchTool, defineTool } from './define-tool.js';
import { toolFailure } from './tool-failure.js';
import { executeToolCall } from './execute-tool-call.js';
import { createToolRegistry } from './tool-registry.js';
import type { ToolContext } from './tool-types.js';

const CONTEXT: Omit<ToolContext, 'callId'> = { agentName: 'a', instanceId: 'i', runId: 'r', signal: new AbortController().signal };
const now = () => 0;

function registryWith(run: () => Promise<unknown>, timeoutMs?: number) {
  return createToolRegistry([defineTool({
    name: 'work', description: 'work', args: z.object({ n: z.number() }).strict(), deterministic: false, cache: false, timeoutMs,
    describeActivity: () => ({ title: 'w' }), run,
  })]);
}

describe('executeToolCall', () => {
  it('returns a success envelope and outcome', async () => {
    const executed = await executeToolCall({ registry: registryWith(async () => 42), call: { id: 'c1', name: 'work', args: { n: 1 } }, context: CONTEXT, now });
    expect(executed.envelope).toEqual({ id: 'c1', tool: 'work', ok: true, result: 42 });
    expect(executed.outcome.success).toBe(true);
  });

  it('reports unknown tools with the available names', async () => {
    const executed = await executeToolCall({ registry: registryWith(async () => 1), call: { id: 'c1', name: 'nope', args: {} }, context: CONTEXT, now });
    expect(executed.envelope).toMatchObject({ ok: false, error: { category: 'unknown_tool', suggestion: expect.stringContaining('work') } });
  });

  it('reports validation failures with field errors and does not run the tool', async () => {
    let ran = false;
    const executed = await executeToolCall({ registry: registryWith(async () => { ran = true; }), call: { id: 'c1', name: 'work', args: { n: 'x' } }, context: CONTEXT, now });
    expect(ran).toBe(false);
    expect(executed.envelope).toMatchObject({ ok: false, error: { category: 'validation', retryable: true, fieldErrors: [{ path: 'n' }] } });
  });

  it('captures structured tool failures, thrown errors and non-Error throws', async () => {
    const structured = await executeToolCall({ registry: registryWith(async () => { throw toolFailure({ code: 'denied_path', message: 'outside root', retryable: false, suggestion: 'use src/' }); }), call: { id: 'c', name: 'work', args: { n: 1 } }, context: CONTEXT, now });
    expect(structured.envelope).toMatchObject({ ok: false, error: { code: 'denied_path', suggestion: 'use src/' } });
    const plain = await executeToolCall({ registry: registryWith(async () => { throw new Error('boom'); }), call: { id: 'c', name: 'work', args: { n: 1 } }, context: CONTEXT, now });
    expect(plain.envelope).toMatchObject({ ok: false, error: { code: 'tool_threw', message: 'boom' } });
    const weird = await executeToolCall({ registry: registryWith(async () => { throw 'str'; }), call: { id: 'c', name: 'work', args: { n: 1 } }, context: CONTEXT, now });
    expect(weird.envelope).toMatchObject({ ok: false, error: { code: 'tool_threw' } });
  });

  const unprintableThrows: [string, () => unknown][] = [
    ['a null-prototype object', () => Object.create(null)],
    ['an object whose toString throws', () => ({ toString() { throw new Error('no string for you'); } })],
  ];

  it.each(unprintableThrows)('resolves with a tool_threw envelope when the tool throws %s', async (_label, makeThrown) => {
    const executed = await executeToolCall({ registry: registryWith(async () => { throw makeThrown(); }), call: { id: 'c', name: 'work', args: { n: 1 } }, context: CONTEXT, now });
    expect(executed.envelope).toMatchObject({ id: 'c', ok: false, error: { category: 'thrown', code: 'tool_threw', message: expect.stringContaining('non-Error value') } });
  });

  // JavaScript consumers (or casts) can hand back a plain value or throw synchronously; neither may be misreported.
  it('treats a plain (non-Promise) return value as success', async () => {
    const syncRun = (() => 7) as unknown as () => Promise<unknown>;
    const executed = await executeToolCall({ registry: registryWith(syncRun), call: { id: 'c', name: 'work', args: { n: 1 } }, context: CONTEXT, now });
    expect(executed.envelope).toEqual({ id: 'c', tool: 'work', ok: true, result: 7 });
  });

  it('reports a synchronous throw from run as tool_threw with its message', async () => {
    const syncThrow = (() => { throw new Error('sync boom'); }) as unknown as () => Promise<unknown>;
    const executed = await executeToolCall({ registry: registryWith(syncThrow), call: { id: 'c', name: 'work', args: { n: 1 } }, context: CONTEXT, now });
    expect(executed.envelope).toMatchObject({ ok: false, error: { code: 'tool_threw', message: 'sync boom' } });
  });

  it('times out tools that never settle', async () => {
    const executed = await executeToolCall({ registry: registryWith(() => new Promise(() => undefined), 20), call: { id: 'c', name: 'work', args: { n: 1 } }, context: CONTEXT, now });
    expect(executed.envelope).toMatchObject({ ok: false, error: { category: 'timeout', retryable: true } });
  });

  it('reports aborted calls when the run signal aborts', async () => {
    const controller = new AbortController();
    const pending = executeToolCall({ registry: registryWith(() => new Promise(() => undefined), 10_000), call: { id: 'c', name: 'work', args: { n: 1 } }, context: { ...CONTEXT, signal: controller.signal }, now });
    controller.abort();
    expect((await pending).envelope).toMatchObject({ ok: false, error: { category: 'aborted' } });
  });
});

describe('executeToolCall result sizing', () => {
  function sizedRegistry(run: () => Promise<unknown>, maxResultTokens?: number) {
    return createToolRegistry([defineTool({
      name: 'work', description: 'work', args: z.object({ n: z.number() }).strict(), deterministic: false, cache: false, maxResultTokens,
      describeActivity: () => ({ title: 'w' }), run,
    })]);
  }

  it('gives the tool its own call id in the context', async () => {
    let seen: ToolContext | undefined;
    const registry = createToolRegistry([defineTool({ name: 'work', description: 'w', args: z.object({}).strict(), deterministic: false, cache: false, describeActivity: () => ({ title: 'w' }), run: async (_args, context) => { seen = context; return 1; } })]);
    await executeToolCall({ registry, call: { id: 'c9', name: 'work', args: {} }, context: CONTEXT, now });
    expect(seen).toEqual({ ...CONTEXT, callId: 'c9' });
  });

  it('records the result size and leaves results within budget untouched', async () => {
    const executed = await executeToolCall({ registry: sizedRegistry(async () => 'abc', 5), call: { id: 'c1', name: 'work', args: { n: 1 } }, context: CONTEXT, now });
    expect(executed.envelope).toEqual({ id: 'c1', tool: 'work', ok: true, result: 'abc' });
    expect(executed.size).toEqual({ resultBytes: 5, resultTokens: 2, truncated: false });
  });

  it('truncates the model-visible result past maxResultTokens and flags it, keeping the original size', async () => {
    const executed = await executeToolCall({ registry: sizedRegistry(async () => 'abcdefghijklmnopqrstuvwxyz', 2), call: { id: 'c1', name: 'work', args: { n: 1 } }, context: CONTEXT, now });
    expect(executed.envelope).toEqual({ id: 'c1', tool: 'work', ok: true, result: { truncated: true, note: 'Result truncated to ~2 tokens (was ~7); narrow the request or page through it.', preview: '"abcdefg' } });
    expect(executed.size).toEqual({ resultBytes: 28, resultTokens: 7, truncated: true });
    expect(executed.outcome).toEqual({ success: true, reason: 'completed' });
  });

  it('never truncates a failed envelope', async () => {
    const longMessage = 'x'.repeat(400);
    const executed = await executeToolCall({ registry: sizedRegistry(async () => { throw new Error(longMessage); }, 1), call: { id: 'c1', name: 'work', args: { n: 1 } }, context: CONTEXT, now });
    expect(executed.envelope).toMatchObject({ ok: false, error: { message: longMessage } });
    expect(executed.size.truncated).toBe(false);
    expect(executed.size.resultTokens).toBeGreaterThan(100);
  });

  it('counts batch items and their failures from the full result even when the visible result is truncated', async () => {
    const batch = defineBatchTool({
      name: 'read_all', description: 'r', item: z.object({ id: z.string() }).strict(), maxItems: 5, deterministic: true, cache: false, maxResultTokens: 1,
      describeActivity: () => ({ title: 'r' }), runItem: async batchItem => { if (batchItem.id === 'bad') throw new Error('unreadable'); return batchItem.id.repeat(50); },
    });
    const executed = await executeToolCall({ registry: createToolRegistry([batch]), call: { id: 'b1', name: 'read_all', args: { items: [{ id: 'ok' }, { id: 'bad' }] } }, context: CONTEXT, now });
    expect(executed.size.truncated).toBe(true);
    expect(executed.items).toEqual({ total: 2, failed: 1 });
    expect(executed.nested).toEqual([expect.objectContaining({ code: 'tool_threw', message: 'unreadable', details: { itemIndex: 1 } })]);
  });

  it('reports no items and no nested failures for a plain tool', async () => {
    const executed = await executeToolCall({ registry: sizedRegistry(async () => 1), call: { id: 'c1', name: 'work', args: { n: 1 } }, context: CONTEXT, now });
    expect(executed.items).toBeUndefined();
    expect(executed.nested).toEqual([]);
  });
});
