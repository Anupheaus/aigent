import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, toolFailure } from './define-tool.js';
import { executeToolCall } from './execute-tool-call.js';
import { createToolRegistry } from './tool-registry.js';
import type { ToolContext } from './tool-types.js';

const CONTEXT: ToolContext = { agentName: 'a', instanceId: 'i', runId: 'r', signal: new AbortController().signal };
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
