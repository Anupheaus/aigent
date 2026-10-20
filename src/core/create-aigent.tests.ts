import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Provider, ProviderEvent } from '../providers/provider-types.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { defineBatchTool, defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import { createAigentError } from './aigent-error.js';
import { createAigent } from './create-aigent.js';
import type { AigentEvent } from './aigent-events.js';
import type { Clock, IdGenerator } from './runtime-services.js';

const clock: Clock = { now: () => 1_000 };
function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

const echoTool = defineTool({
  name: 'echo', description: 'Echo text', args: z.object({ text: z.string() }).strict(),
  deterministic: true, cache: false, describeActivity: args => ({ title: `Echo ${args.text}` }), run: async args => args.text,
});

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

interface SetupOptions {
  turns: FakeTurn[];
  /** Defaults to the echo tool. */
  tools?: Tool[];
  store?: Store;
}

function setup(options: SetupOptions) {
  const { turns, tools = [echoTool], store } = options;
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], clock, ids: sequentialIds(), store });
  const agent = ai.agent({ name: 'helper', model: 'fake:test-model', persona: 'Calm', skillset: 'Can echo', tools });
  return { provider, ai, agent };
}

describe('agent.task', () => {
  it('answers a plain task and reports usage', async () => {
    const { agent, provider } = setup({ turns: [textTurn('The answer')] });
    const result = await agent.task({ task: 'Say it' });
    expect(result).toMatchObject({ status: 'completed', answer: 'The answer', agentName: 'helper', usage: { inputTokens: 10, outputTokens: 5, turns: 1, toolCalls: 0 } });
    expect(provider.requests[0]?.messages[0]).toMatchObject({ role: 'system' });
    expect(provider.requests[0]?.messages[0]?.text).toContain('Calm');
    expect(provider.requests[0]?.messages[1]).toMatchObject({ role: 'user', text: '# Task\nSay it' });
    expect(provider.requests[0]?.model).toBe('test-model');
    expect(provider.requests[0]?.tools.map(tool => tool.name)).toEqual(['aigent_multi', 'echo']);
  });

  it('keeps completed thinking blocks on the assistant message it replays, without emitting them to the consumer', async () => {
    const thinking: ProviderEvent = { type: 'thinking-block', block: { type: 'thinking', thinking: 'echo it', signature: 'sig-1' } };
    const redacted: ProviderEvent = { type: 'thinking-block', block: { type: 'redacted-thinking', data: 'opaque' } };
    const call = { id: 'c1', name: 'echo', args: { text: 'a' } };
    const { agent, provider } = setup({ turns: [{ events: [thinking, redacted, ...toolTurn([call]).events] }, textTurn('done')] });
    const events = await collect(agent.task({ task: 'Echo' }));
    expect(provider.requests[1]?.messages[2]).toEqual({
      role: 'assistant', text: '', toolCalls: [call],
      thinkingBlocks: [{ type: 'thinking', thinking: 'echo it', signature: 'sig-1' }, { type: 'redacted-thinking', data: 'opaque' }],
    });
    expect(events.map(({ type }) => type)).not.toContain('thinking-block');
  });

  it('marks aigent_multi as the only non-strict tool in the provider request', async () => {
    const { agent, provider } = setup({ turns: [textTurn('ok')] });
    await agent.task({ task: 'x' });
    expect(provider.requests[0]?.tools.map(({ name, strict }) => ({ name, strict }))).toEqual([{ name: 'aigent_multi', strict: false }, { name: 'echo', strict: true }]);
  });

  it('runs tools in a loop and feeds structured envelopes back', async () => {
    const { agent, provider } = setup({ turns: [
      toolTurn([{ id: 'c1', name: 'echo', args: { text: 'hi' } }, { id: 'c2', name: 'echo', args: { text: 5 } }]),
      textTurn('Done'),
    ] });
    const result = await agent.task({ task: 'Echo' });
    expect(result).toMatchObject({ status: 'completed', answer: 'Done', usage: { turns: 2, toolCalls: 2 } });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ category: 'validation' });
    const second = provider.requests[1]!.messages;
    expect(second.at(-3)).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'c1' }, { id: 'c2' }] });
    expect(JSON.parse(second.at(-2)!.text!)).toEqual({ id: 'c1', tool: 'echo', ok: true, result: 'hi' });
    expect(second.at(-2)).toMatchObject({ role: 'tool', toolCallId: 'c1' });
    expect(JSON.parse(second.at(-1)!.text!)).toMatchObject({ id: 'c2', ok: false, error: { category: 'validation' } });
  });

  it('emits ordered events including tool activity, directives (stripped from text) and a final done', async () => {
    const { agent } = setup({ turns: [
      toolTurn([{ id: 'c1', name: 'echo', args: { text: 'hi' } }]),
      textTurn('Hello\n::aigent status {"text":"Wrapping up"}\nWorld', { chunkSize: 4 }),
    ] });
    const events = await collect(agent.task({ task: 'Echo' }));
    const types = events.map(event => event.type);
    expect(types.indexOf('tool-call')).toBeLessThan(types.indexOf('tool-result'));
    expect(events).toContainEqual({ type: 'tool-activity', callId: 'c1', view: { title: 'Echo hi' } });
    expect(events).toContainEqual({ type: 'directive', directive: { type: 'status', data: { text: 'Wrapping up' } } });
    const visible = events.filter(event => event.type === 'text-delta').map(event => event.text).join('');
    expect(visible).toBe('Hello\nWorld');
    expect(events.at(-1)).toEqual({ type: 'done', status: 'completed' });
  });

  // A UI shows a row per tool-call; calls that never run still need an activity row saying why.
  it('emits a tool-activity for calls that are not run: unknown tool, invalid args and limit refusals', async () => {
    const { agent } = setup({ turns: [
      toolTurn([
        { id: 'u1', name: 'nope', args: {} },
        { id: 'v1', name: 'echo', args: { text: 5 } },
        { id: 'ok', name: 'echo', args: { text: 'fine' } },
        { id: 'l1', name: 'echo', args: { text: 'over' } },
      ]),
      textTurn('done'),
    ] });
    const events = await collect(agent.task({ task: 'x', limits: { maxToolCalls: 3 } }));
    const activityFor = (callId: string) => events.filter(event => event.type === 'tool-activity' && event.callId === callId);
    expect(activityFor('u1')).toEqual([{ type: 'tool-activity', callId: 'u1', view: { title: "Call to 'nope' was not run", detail: expect.stringContaining("Unknown tool 'nope'") } }]);
    expect(activityFor('v1')).toEqual([{ type: 'tool-activity', callId: 'v1', view: { title: "Call to 'echo' was not run", detail: expect.stringContaining('failed validation') } }]);
    expect(activityFor('l1')).toEqual([{ type: 'tool-activity', callId: 'l1', view: { title: "Call to 'echo' was not run", detail: expect.stringContaining('Tool call limit') } }]);
    expect(activityFor('ok')).toEqual([{ type: 'tool-activity', callId: 'ok', view: { title: 'Echo fine' } }]);
    const types = events.filter(event => 'callId' in event && event.callId === 'u1').map(event => event.type);
    expect(types).toEqual(['tool-call', 'tool-activity', 'tool-result']);
  });

  it('is awaitable and iterable with identical events', async () => {
    const { agent } = setup({ turns: [textTurn('A')] });
    const run = agent.task({ task: 'x' });
    const first = await collect(run);
    const result = await run;
    expect(result.status).toBe('completed');
    expect(await collect(run)).toEqual(first);
  });

  it('dispatches a tool as soon as its call arrives, before the model finishes the turn', async () => {
    let toolStartedAt = 0;
    let turnFinishedAt = 0;
    const slowTurn = toolTurn([{ id: 'c1', name: 'echo', args: { text: 'a' } }], { delayMs: 40 });
    const tool = defineTool({ name: 'echo', description: 'e', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 'e' }), run: async () => { toolStartedAt = Date.now(); return 1; } });
    const { agent } = setup({ turns: [slowTurn, textTurn('ok')], tools: [tool] });
    for await (const event of agent.task({ task: 'x' })) {
      if (event.type === 'usage' && turnFinishedAt === 0) turnFinishedAt = Date.now();
    }
    expect(toolStartedAt).toBeGreaterThan(0);
    expect(toolStartedAt).toBeLessThan(turnFinishedAt);
  });

  it('runs batch tools and aigent_multi through the loop', async () => {
    const batch = defineBatchTool({ name: 'read_all', description: 'r', item: z.object({ id: z.string() }).strict(), maxItems: 5, deterministic: true, cache: false, describeActivity: () => ({ title: 'r' }), runItem: async item => item.id });
    const { agent, provider } = setup({ turns: [
      toolTurn([{ id: 'c1', name: 'aigent_multi', args: { calls: [{ id: 'x', tool: 'read_all', args: { items: [{ id: 'a' }] } }] } }]),
      textTurn('fine'),
    ], tools: [batch] });
    const result = await agent.task({ task: 'x' });
    expect(result).toMatchObject({ status: 'completed', usage: { toolCalls: 1 } });
    expect(result.errors).toEqual([]);
    const multiEnvelope = JSON.parse(provider.requests[1]!.messages.at(-1)!.text!);
    expect(multiEnvelope).toEqual({ id: 'c1', tool: 'aigent_multi', ok: true, result: [{ id: 'x', tool: 'read_all', ok: true, result: [{ index: 0, ok: true, result: 'a' }] }] });
  });

  it('stops with limit_reached at maxTurns and refuses calls beyond maxToolCalls', async () => {
    const loopTurns = Array.from({ length: 5 }, (_, turn) => toolTurn([{ id: `c${turn}`, name: 'echo', args: { text: 'x' } }]));
    const { agent } = setup({ turns: loopTurns });
    const limited = await agent.task({ task: 'x', limits: { maxTurns: 2 } });
    expect(limited.status).toBe('limit_reached');
    const capped = setup({ turns: [toolTurn([{ id: 'a', name: 'echo', args: { text: 'x' } }, { id: 'b', name: 'echo', args: { text: 'y' } }]), textTurn('ok')] });
    const result = await capped.agent.task({ task: 'x', limits: { maxToolCalls: 1 } });
    expect(result.errors).toEqual([expect.objectContaining({ category: 'denied', code: 'tool_call_limit' })]);
  });

  it('reports a provider failure as a failed result instead of throwing', async () => {
    const { agent } = setup({ turns: [] });
    const result = await agent.task({ task: 'x' });
    expect(result.status).toBe('failed');
    expect(result.failure).toMatch(/no scripted turn/);
  });

  it('immediate stop aborts the stream mid-turn and settles as cancelled; repeated stop is harmless', async () => {
    const { agent, provider } = setup({ turns: [textTurn('abcdefghij', { chunkSize: 1, delayMs: 10 })] });
    const run = agent.task({ task: 'x' });
    setTimeout(() => { run.cancel(); run.stop({ mode: 'immediate' }); }, 25);
    const result = await run;
    expect(result.status).toBe('cancelled');
    expect(result.stopMode).toBe('immediate');
    expect(provider.requests).toHaveLength(1);
  });

  it('immediate stop mid-stream with a tool in flight settles cancelled and leaves no pending timers', async () => {
    vi.useFakeTimers();
    try {
      const streamingTurn: FakeTurn = {
        events: [
          { type: 'tool-call', call: { id: 'h1', name: 'hang', args: {} } },
          ...Array.from({ length: 10 }, (): ProviderEvent => ({ type: 'text-delta', text: 'x' })),
          { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } },
          { type: 'done', finishReason: 'tool_calls' },
        ],
        delayMs: 10,
      };
      const { agent, provider } = setup({ turns: [streamingTurn, textTurn('never')], tools: [hangingTool] });
      // A run-level timeout and the tool's own 60 s timeout are both pending when the stop lands.
      const run = agent.task({ task: 'x', limits: { timeoutMs: 60_000 } });
      const eventsDone = collect(run);
      await vi.advanceTimersByTimeAsync(25);
      run.cancel();
      run.stop({ mode: 'immediate' });
      const result = await run;
      const events = await eventsDone;
      expect(result).toMatchObject({ status: 'cancelled', stopMode: 'immediate', usage: { toolCalls: 1 } });
      expect(result.errors).toEqual([expect.objectContaining({ code: 'tool_aborted' })]);
      // The tool was in flight while the stream was still open: no usage (end of stream) arrived before the stop.
      expect(events.map(event => event.type)).toContain('tool-call');
      expect(events.map(event => event.type)).not.toContain('usage');
      expect(events.at(-1)).toEqual({ type: 'done', status: 'cancelled' });
      expect(provider.requests).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('graceful stop finishes the current turn then ends stopped without a new request', async () => {
    const { agent, provider } = setup({ turns: [toolTurn([{ id: 'c1', name: 'echo', args: { text: 'x' } }], { delayMs: 15 }), textTurn('never')] });
    const run = agent.task({ task: 'x' });
    setTimeout(() => run.stop({ mode: 'graceful' }), 5);
    const result = await run;
    expect(result).toMatchObject({ status: 'stopped', stopMode: 'graceful', usage: { toolCalls: 1 } });
    expect(provider.requests).toHaveLength(1);
  });

  it('an external AbortSignal cancels the run', async () => {
    const { agent } = setup({ turns: [textTurn('abcdef', { chunkSize: 1, delayMs: 10 })] });
    const controller = new AbortController();
    const run = agent.task({ task: 'x', signal: controller.signal });
    setTimeout(() => controller.abort(), 15);
    expect((await run).status).toBe('cancelled');
  });

  it('rejects invalid input synchronously and unknown providers at agent creation', () => {
    const { agent, ai } = setup({ turns: [textTurn('x')] });
    expect(() => agent.task({ task: '' })).toThrow(/task/);
    expect(() => ai.agent({ name: 'x', model: 'nope:model' })).toThrow(/nope.*fake/);
    expect(() => ai.agent({ name: 'x', model: 'missing-colon' })).toThrow(/provider:model/);
  });

  it('writes a run record through the queue and flushes it before the run resolves', async () => {
    const store = createInMemoryStore();
    const { agent, ai } = setup({ turns: [textTurn('ok')], tools: [echoTool], store });
    const result = await agent.task({ task: 'x', label: 'step-1', scope: { userId: 'u1' } });
    const record = await store.get<Record<string, unknown>>('runs', result.runId);
    expect(record?.value).toMatchObject({ runId: result.runId, agentName: 'helper', status: 'completed', label: 'step-1', scope: { userId: 'u1' }, startedAt: 1_000 });
    await ai.close();
  });

  it('close waits for in-flight runs so their records are written before it resolves', async () => {
    const store = createInMemoryStore();
    const { agent, ai } = setup({ turns: [textTurn('slow answer', { delayMs: 20 }), textTurn('second', { delayMs: 5 })], tools: [echoTool], store });
    const first = agent.task({ task: 'x' });
    const second = agent.task({ task: 'y' });
    await ai.close();
    expect((await store.list('runs')).map(record => record.key).sort()).toEqual([first.runId, second.runId].sort());
  });

  it('close resolves immediately when nothing is running', async () => {
    const { ai } = setup({ turns: [] });
    await expect(ai.close()).resolves.toBeUndefined();
  });

  it('writes nothing when disableTelemetry is set', async () => {
    const store = createInMemoryStore();
    const { agent } = setup({ turns: [textTurn('ok')], tools: [echoTool], store });
    await agent.task({ task: 'x', disableTelemetry: true });
    expect(await store.list('runs')).toEqual([]);
  });

  it.each([
    ['maxTurns', { maxTurns: 0 }],
    ['maxToolCalls', { maxToolCalls: -1 }],
    ['timeoutMs', { timeoutMs: -10 }],
    ['timeoutMs', { timeoutMs: 1.5 }],
  ])('rejects invalid agent limits (%s) at definition time with invalid_definition', (field, limits) => {
    const { ai } = setup({ turns: [] });
    expect(() => ai.agent({ name: 'limited', model: 'fake:m', limits })).toThrow(expect.objectContaining({
      code: 'invalid_definition',
      message: expect.stringMatching(new RegExp(`Agent 'limited'.*limits.*${field}`)),
    }));
  });

  it('rejects unknown agent limit keys', () => {
    const { ai } = setup({ turns: [] });
    const limits = { maxTurns: 2, maxTokens: 5 } as unknown as { maxTurns: number };
    expect(() => ai.agent({ name: 'limited', model: 'fake:m', limits })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringContaining('maxTokens') }));
  });

  it('gives each agent a stable unique instanceId unless one is provided', () => {
    const { ai } = setup({ turns: [] });
    const first = ai.agent({ name: 'a', model: 'fake:m' });
    const second = ai.agent({ name: 'a', model: 'fake:m' });
    const restored = ai.agent({ name: 'a', model: 'fake:m', instanceId: 'fixed' });
    expect(first.instanceId).not.toBe(second.instanceId);
    expect(restored.instanceId).toBe('fixed');
  });
});

describe('agent.task aigent_multi and batch accounting', () => {
  it('reports toolCallsPerTurn as tool calls per model request: 50 calls in 3 turns', async () => {
    const callsFor = (turn: number) => Array.from({ length: 25 }, (_, index) => ({ id: `t${turn}c${index}`, name: 'echo', args: { text: 'x' } }));
    const store = createInMemoryStore();
    const { agent } = setup({ turns: [toolTurn(callsFor(1)), toolTurn(callsFor(2)), textTurn('done')], store });
    const result = await agent.task({ task: 'x' });
    expect(result.usage).toMatchObject({ turns: 3, toolCalls: 50 });
    expect(result.usage.toolCallsPerTurn).toBeCloseTo(50 / 3, 5);
    expect(result.usage.toolCallsPerTurn).toBeCloseTo(16.7, 1);
    const record = await store.get<{ usage: { toolCallsPerTurn: number } }>('runs', result.runId);
    expect(record?.value.usage.toolCallsPerTurn).toBeCloseTo(50 / 3, 5);
  });

  it('counts one aigent_multi with N inner calls as N tool calls in one turn (plus the answer turn)', async () => {
    const innerCalls = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, tool: 'echo', args: { text: id } }));
    const { agent } = setup({ turns: [toolTurn([{ id: 'm1', name: 'aigent_multi', args: { calls: innerCalls } }]), textTurn('done')] });
    const result = await agent.task({ task: 'x' });
    expect(result.usage).toMatchObject({ turns: 2, toolCalls: 5, toolCallsPerTurn: 2.5 });
  });

  it('reports toolCallsPerTurn 0 when no model request was made', async () => {
    const controller = new AbortController();
    controller.abort();
    const { agent } = setup({ turns: [textTurn('never')] });
    const result = await agent.task({ task: 'x', signal: controller.signal });
    expect(result.usage).toMatchObject({ turns: 0, toolCalls: 0, toolCallsPerTurn: 0 });
  });

  it('counts every aigent_multi inner call toward maxToolCalls and refuses the rest', async () => {
    let echoRuns = 0;
    const counted = defineTool({ name: 'echo', description: 'e', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 'e' }), run: async args => { echoRuns += 1; return args.text; } });
    const calls = ['a', 'b', 'c'].map(id => ({ id, tool: 'echo', args: { text: 'x' } }));
    const { agent, provider } = setup({ turns: [toolTurn([{ id: 'm1', name: 'aigent_multi', args: { calls } }]), textTurn('ok')], tools: [counted] });
    const result = await agent.task({ task: 'x', limits: { maxToolCalls: 1 } });
    expect(echoRuns).toBe(1);
    expect(result.usage.toolCalls).toBe(1);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'tool_call_limit', details: { callId: 'b', tool: 'echo', parentCallId: 'm1' } }),
      expect.objectContaining({ code: 'tool_call_limit', details: { callId: 'c', tool: 'echo', parentCallId: 'm1' } }),
    ]);
    const multiEnvelope = JSON.parse(provider.requests[1]!.messages.at(-1)!.text!);
    expect(multiEnvelope).toMatchObject({ id: 'm1', tool: 'aigent_multi', ok: true, result: [{ id: 'a', ok: true, result: 'x' }, { id: 'b', ok: false }, { id: 'c', ok: false }] });
  });

  it('refuses aigent_multi outright once the budget is spent', async () => {
    const calls = [{ id: 'a', tool: 'echo', args: { text: 'x' } }];
    const { agent } = setup({ turns: [toolTurn([{ id: 'e1', name: 'echo', args: { text: 'x' } }, { id: 'm1', name: 'aigent_multi', args: { calls } }]), textTurn('ok')] });
    const result = await agent.task({ task: 'x', limits: { maxToolCalls: 1 } });
    expect(result.usage.toolCalls).toBe(1);
    expect(result.errors).toEqual([expect.objectContaining({ code: 'tool_call_limit' })]);
  });

  it('reports failures inside aigent_multi and batch results in TaskResult.errors', async () => {
    const batch = defineBatchTool({ name: 'read_all', description: 'r', item: z.object({ id: z.string() }).strict(), maxItems: 5, deterministic: true, cache: false, describeActivity: () => ({ title: 'r' }), runItem: async batchItem => { if (batchItem.id === 'bad') throw new Error('unreadable'); return batchItem.id; } });
    const { agent } = setup({ turns: [
      toolTurn([
        { id: 'b1', name: 'read_all', args: { items: [{ id: 'ok' }, { id: 'bad' }] } },
        { id: 'm1', name: 'aigent_multi', args: { calls: [{ id: 'x', tool: 'echo', args: { text: 5 } }] } },
      ]),
      textTurn('fine'),
    ], tools: [echoTool, batch] });
    const result = await agent.task({ task: 'x' });
    expect(result.status).toBe('completed');
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'tool_threw', message: 'unreadable', details: { itemIndex: 1, parentCallId: 'b1' } }),
      expect.objectContaining({ category: 'validation', details: { callId: 'x', tool: 'echo', parentCallId: 'm1' } }),
    ]);
  });
});

describe('agent.task tool failure containment', () => {
  it('settles with a TaskResult when a tool throws a value that cannot be turned into a string', async () => {
    const hostile = defineTool({
      name: 'echo', description: 'e', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false,
      describeActivity: () => ({ title: 'e' }), run: async () => { throw Object.create(null); },
    });
    const { agent } = setup({ turns: [toolTurn([{ id: 'c1', name: 'echo', args: { text: 'a' } }]), textTurn('recovered')], tools: [hostile] });
    const run = agent.task({ task: 'x' });
    const events = await collect(run);
    const result = await run;
    expect(result).toMatchObject({ status: 'completed', answer: 'recovered' });
    expect(result.errors).toEqual([expect.objectContaining({ category: 'thrown', code: 'tool_threw' })]);
    expect(events.at(-1)).toEqual({ type: 'done', status: 'completed' });
  });

  it('reports a renderer that throws an unprintable value as a warning', async () => {
    const tool = defineTool({
      name: 'echo', description: 'e', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false,
      describeActivity: () => { throw Object.create(null); }, run: async args => args.text,
    });
    const { agent } = setup({ turns: [toolTurn([{ id: 'c1', name: 'echo', args: { text: 'a' } }]), textTurn('ok')], tools: [tool] });
    const events = await collect(agent.task({ task: 'x' }));
    expect(events).toContainEqual({ type: 'warning', message: expect.stringContaining("describeActivity for tool 'echo' failed") });
    expect(events.at(-1)).toEqual({ type: 'done', status: 'completed' });
  });
});

const SCRIPTED_CAPABILITIES: Provider['capabilities'] = { streaming: true, toolCalling: true, parallelToolCalls: true, promptCaching: false, vision: false, maxContextTokens: 1_000, supportedSettings: [] };

/** An agent over a hand-written provider stream, for failure modes the FakeProvider cannot script. */
function scriptedAgent(options: { stream: Provider['stream']; tools?: Tool[] }) {
  const { stream, tools = [] } = options;
  const provider: Provider = { id: 'scripted', capabilities: SCRIPTED_CAPABILITIES, stream };
  return createAigent({ providers: [provider], clock, ids: sequentialIds() }).agent({ name: 'helper', model: 'scripted:m', tools });
}

const hangingTool = defineTool({
  name: 'hang', description: 'h', args: z.object({}).strict(), deterministic: true, cache: false, timeoutMs: 60_000,
  describeActivity: () => ({ title: 'h' }), run: () => new Promise(() => undefined),
});

describe('agent.task abort reasons', () => {
  it('says a tool was aborted because the provider failed, not because the run was stopped', async () => {
    const agent = scriptedAgent({
      tools: [hangingTool],
      stream: async function* () {
        yield { type: 'tool-call', call: { id: 'h1', name: 'hang', args: {} } };
        await new Promise(resolve => setTimeout(resolve, 5));
        throw createAigentError({ code: 'provider_failed', message: 'upstream 500' });
      },
    });
    const result = await agent.task({ task: 'x' });
    expect(result).toMatchObject({ status: 'failed', failure: 'upstream 500' });
    expect(result.errors).toEqual([expect.objectContaining({ category: 'aborted', code: 'tool_aborted', message: expect.stringContaining('provider failed') })]);
    expect(result.errors[0]?.message).not.toContain('stopped');
  });

  it('says a tool was aborted because the run timed out', async () => {
    const agent = scriptedAgent({ tools: [hangingTool], stream: async function* () { yield { type: 'tool-call', call: { id: 'h1', name: 'hang', args: {} } }; } });
    const result = await agent.task({ task: 'x', limits: { timeoutMs: 20 } });
    expect(result.status).toBe('limit_reached');
    expect(result.errors).toEqual([expect.objectContaining({ code: 'tool_aborted', message: expect.stringContaining('timeoutMs') })]);
  });

  it('says a tool was aborted because the run was stopped on cancel', async () => {
    const agent = scriptedAgent({ tools: [hangingTool], stream: async function* () { yield { type: 'tool-call', call: { id: 'h1', name: 'hang', args: {} } }; } });
    const run = agent.task({ task: 'x' });
    setTimeout(() => run.cancel(), 10);
    const result = await run;
    expect(result.status).toBe('cancelled');
    expect(result.errors).toEqual([expect.objectContaining({ code: 'tool_aborted', message: expect.stringContaining('stopped') })]);
  });

  it('reports a provider error coded aborted as a failure when the run itself was not aborted', async () => {
    const agent = scriptedAgent({ stream: async function* () { yield* []; throw createAigentError({ code: 'aborted', message: 'upstream connection aborted' }); } });
    const result = await agent.task({ task: 'x' });
    expect(result).toMatchObject({ status: 'failed', failure: 'upstream connection aborted' });
    expect(result.stopMode).toBeUndefined();
  });
});

describe('agent.task run control', () => {
  it('finishes the run with a warning when a tool renderer never settles', async () => {
    const tool = defineTool({
      name: 'echo', description: 'e', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false,
      describeActivity: () => new Promise(() => undefined), run: async args => args.text,
    });
    const { agent } = setup({ turns: [toolTurn([{ id: 'c1', name: 'echo', args: { text: 'a' } }]), textTurn('done')], tools: [tool] });
    const run = agent.task({ task: 'x' });
    const events = await collect(run);
    expect((await run).status).toBe('completed');
    expect(events).toContainEqual({ type: 'warning', message: expect.stringMatching(/activity.*did not settle/) });
    expect(events.at(-1)).toEqual({ type: 'done', status: 'completed' });
  });

  it('cancel settles the run even when a renderer never settles', async () => {
    const tool = defineTool({
      name: 'echo', description: 'e', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false,
      describeActivity: async function* () { yield { title: 'waiting forever' }; await new Promise(() => undefined); },
      run: () => new Promise(() => undefined),
    });
    const { agent } = setup({ turns: [toolTurn([{ id: 'c1', name: 'echo', args: { text: 'a' } }]), textTurn('never')], tools: [tool] });
    const run = agent.task({ task: 'x' });
    setTimeout(() => run.cancel(), 20);
    const result = await run;
    expect(result.status).toBe('cancelled');
  });

  it('settles as cancelled when aborted while tools run after the stream finished', async () => {
    const slowTool = defineTool({
      name: 'echo', description: 'e', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false,
      describeActivity: () => ({ title: 'e' }), run: () => new Promise(resolve => setTimeout(() => resolve('late'), 5_000)),
    });
    const { agent, provider } = setup({ turns: [toolTurn([{ id: 'c1', name: 'echo', args: { text: 'a' } }]), textTurn('never')], tools: [slowTool] });
    const run = agent.task({ task: 'x' });
    setTimeout(() => run.cancel(), 30);
    const events = await collect(run);
    const result = await run;
    expect(result).toMatchObject({ status: 'cancelled', stopMode: 'immediate', usage: { toolCalls: 1 } });
    expect(result.errors).toEqual([expect.objectContaining({ category: 'aborted' })]);
    expect(provider.requests).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'done', status: 'cancelled' });
  });

  describe('with a provider that ignores the abort signal', () => {
    // Yields one chunk, then hangs forever without looking at the signal: a contract breach the run must survive.
    function stubbornProvider() {
      const returnSpy = vi.fn(async (): Promise<IteratorResult<ProviderEvent>> => ({ done: true, value: undefined }));
      let nextCount = 0;
      const provider: Provider = {
        id: 'stubborn',
        capabilities: SCRIPTED_CAPABILITIES,
        stream: () => ({
          [Symbol.asyncIterator]: () => ({
            next: (): Promise<IteratorResult<ProviderEvent>> => {
              nextCount += 1;
              return nextCount === 1 ? Promise.resolve({ done: false, value: { type: 'text-delta', text: 'partial' } }) : new Promise(() => undefined);
            },
            return: returnSpy,
          }),
        }),
      };
      const agent = createAigent({ providers: [provider], clock, ids: sequentialIds() }).agent({ name: 'helper', model: 'stubborn:m' });
      return { agent, returnSpy };
    }

    it('cancel still settles the run as cancelled and asks the stream to return', async () => {
      const { agent, returnSpy } = stubbornProvider();
      const run = agent.task({ task: 'x' });
      setTimeout(() => run.cancel(), 20);
      const events = await collect(run);
      expect((await run).status).toBe('cancelled');
      expect(returnSpy).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual({ type: 'text-delta', text: 'partial' });
      expect(events.at(-1)).toEqual({ type: 'done', status: 'cancelled' });
    });

    it('timeoutMs still ends the run with limit_reached', async () => {
      const { agent, returnSpy } = stubbornProvider();
      const result = await agent.task({ task: 'x', limits: { timeoutMs: 20 } });
      expect(result.status).toBe('limit_reached');
      expect(returnSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('reports limit_reached when timeoutMs elapses', async () => {
    const { agent } = setup({ turns: [textTurn('abcdefghij', { chunkSize: 1, delayMs: 10 })] });
    const result = await agent.task({ task: 'x', limits: { timeoutMs: 25 } });
    expect(result.status).toBe('limit_reached');
    expect(result.stopMode).toBeUndefined();
  });

  it('ignores stop after the run has settled', async () => {
    const { agent } = setup({ turns: [textTurn('ok')] });
    const run = agent.task({ task: 'x' });
    expect((await run).status).toBe('completed');
    run.stop();
    run.cancel();
    expect((await run).status).toBe('completed');
  });

  it('emits done only after the run record is written', async () => {
    const memory = createInMemoryStore();
    // A slow write exposes any ordering bug that an in-memory (microtask-fast) write would hide.
    const store: ReturnType<typeof createInMemoryStore> = {
      ...memory,
      compareAndSet: params => new Promise(resolve => setTimeout(() => resolve(memory.compareAndSet(params)), 20)),
    };
    const { agent } = setup({ turns: [textTurn('ok')], tools: [echoTool], store });
    const run = agent.task({ task: 'x' });
    let recordAtDone: unknown = 'unset';
    for await (const event of run) {
      if (event.type === 'done') recordAtDone = await store.get('runs', run.runId);
    }
    expect(recordAtDone).toMatchObject({ value: { status: 'completed' } });
  });
});
