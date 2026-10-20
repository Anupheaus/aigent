import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { defineBatchTool, defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
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
    const { agent } = setup({ turns: [
      toolTurn([{ id: 'c1', name: 'aigent_multi', args: { calls: [{ id: 'x', tool: 'read_all', argsJson: '{"items":[{"id":"a"}]}' }] } }]),
      textTurn('fine'),
    ], tools: [batch] });
    const result = await agent.task({ task: 'x' });
    expect(result).toMatchObject({ status: 'completed', usage: { toolCalls: 1 } });
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
  it('counts every aigent_multi inner call toward maxToolCalls and refuses the rest', async () => {
    let echoRuns = 0;
    const counted = defineTool({ name: 'echo', description: 'e', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 'e' }), run: async args => { echoRuns += 1; return args.text; } });
    const calls = ['a', 'b', 'c'].map(id => ({ id, tool: 'echo', argsJson: '{"text":"x"}' }));
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
    const calls = [{ id: 'a', tool: 'echo', argsJson: '{"text":"x"}' }];
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
        { id: 'm1', name: 'aigent_multi', args: { calls: [{ id: 'x', tool: 'echo', argsJson: '{"text":5}' }] } },
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
