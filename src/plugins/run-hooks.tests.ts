import { describe, expect, it } from 'vitest';
import { createRunHooks, HOOK_TIMEOUT_MS } from './run-hooks.js';
import type { RegisteredHooks } from './run-hooks.js';
import type { ToolCallInfo } from './plugin-types.js';

const CALL: ToolCallInfo = { runId: 'run_1', agentName: 'helper', callId: 'c1', tool: 'echo', args: { text: 'hi', nested: { deep: [1] } } };
const SHORT_TIMEOUT_MS = 20;

describe('createRunHooks', () => {
  it('uses a 1000 ms timeout per hook by default', () => {
    expect(HOOK_TIMEOUT_MS).toBe(1_000);
  });

  it('calls hooks sequentially in plugin order, one event after another', async () => {
    const order: string[] = [];
    const slow = async (label: string): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 5)); order.push(label); };
    const plugins: RegisteredHooks[] = [
      { plugin: 'a', hooks: { onToolCall: () => slow('a:call'), onError: () => { order.push('a:error'); } } },
      { plugin: 'b', hooks: { onToolCall: () => { order.push('b:call'); } } },
    ];
    const hooks = createRunHooks({ plugins: () => plugins, warn: () => undefined });
    hooks.call({ hook: 'onToolCall', info: CALL });
    hooks.call({ hook: 'onError', info: { runId: 'run_1', agentName: 'helper', message: 'x' } });
    await hooks.settled();
    expect(order).toEqual(['a:call', 'b:call', 'a:error']);
  });

  it('passes a deep-frozen copy, never the live object; mutation attempts throw and become warnings', async () => {
    const warnings: string[] = [];
    let seen: ToolCallInfo | undefined;
    const hooks = createRunHooks({
      plugins: () => [{ plugin: 'meddler', hooks: { onToolCall: info => { seen = info; (info.args as { nested: { deep: number[] } }).nested.deep.push(2); } } }],
      warn: message => warnings.push(message),
    });
    hooks.call({ hook: 'onToolCall', info: CALL });
    await hooks.settled();
    expect(seen).not.toBe(CALL);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(CALL.args).toEqual({ text: 'hi', nested: { deep: [1] } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Plugin 'meddler' hook onToolCall failed: /);
  });

  it('turns a throwing hook into a warning and still runs the next ones', async () => {
    const warnings: string[] = [];
    const calls: string[] = [];
    const hooks = createRunHooks({
      plugins: () => [
        { plugin: 'thrower', hooks: { onToolCall: () => { throw new Error('boom'); } } },
        { plugin: 'rejecter', hooks: { onToolCall: async () => { throw new Error('async boom'); } } },
        { plugin: 'fine', hooks: { onToolCall: () => { calls.push('fine'); } } },
      ],
      warn: message => warnings.push(message),
    });
    hooks.call({ hook: 'onToolCall', info: CALL });
    await hooks.settled();
    expect(warnings).toEqual(["Plugin 'thrower' hook onToolCall failed: boom", "Plugin 'rejecter' hook onToolCall failed: async boom"]);
    expect(calls).toEqual(['fine']);
  });

  it('abandons a hanging hook after the timeout with a warning', async () => {
    const warnings: string[] = [];
    const hooks = createRunHooks({
      plugins: () => [{ plugin: 'stuck', hooks: { onToolCall: () => new Promise<void>(() => undefined) } }],
      warn: message => warnings.push(message), timeoutMs: SHORT_TIMEOUT_MS,
    });
    hooks.call({ hook: 'onToolCall', info: CALL });
    await hooks.settled();
    expect(warnings).toEqual([`Plugin 'stuck' hook onToolCall did not finish within ${SHORT_TIMEOUT_MS} ms; the run continued without it`]);
  });

  it('skips plugins without the hook and settles at once with none queued', async () => {
    const hooks = createRunHooks({ plugins: () => [{ plugin: 'none', hooks: {} }], warn: () => undefined });
    hooks.call({ hook: 'onRunStart', info: { runId: 'r', agentName: 'a', instanceId: 'i', model: 'fake:m', mode: 'task' } });
    await expect(hooks.settled()).resolves.toBeUndefined();
  });
});
