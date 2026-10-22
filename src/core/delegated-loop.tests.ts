import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { DelegatedToolResult, Provider, ProviderEvent, ProviderRequest, ToolCall } from '../providers/provider-types.js';
import { PROVIDER_SETTING_KEYS } from '../providers/provider-settings.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import { createAigentError } from './aigent-error.js';
import type { AigentEvent } from './aigent-events.js';
import { createAigent } from './create-aigent.js';
import type { ResiliencePolicy } from './resilience-policy.js';
import type { Clock, IdGenerator } from './runtime-services.js';

const clock: Clock = { now: () => 1_000 };
function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

/** One scripted delegated turn: the provider runs these calls through the core, then writes the answer. */
interface DelegatedScript {
  calls: ToolCall[];
  answer(results: DelegatedToolResult[]): string;
  /** Wait forever after the calls (until aborted). */
  hangAfterCalls?: boolean;
  /** Run the calls before yielding any event (the stream's first event comes after them). */
  callsFirst?: boolean;
  /** Fail with a retryable `provider_failed` after the calls, before any event. */
  failAfterCalls?: boolean;
  /** Wait this long after the calls, before the next event. */
  delayAfterCallsMs?: number;
}

interface OwnsLoopProvider extends Provider {
  requests: ProviderRequest[];
  signals: AbortSignal[];
}

function ownsLoopProvider(scripts: DelegatedScript[]): OwnsLoopProvider {
  const requests: ProviderRequest[] = [];
  const signals: AbortSignal[] = [];
  async function* stream(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const { toolExecutor, ...copy } = request;
    requests.push(structuredClone(copy));
    signals.push(signal);
    const script = scripts.shift();
    if (script == null) throw createAigentError({ code: 'provider_failed', message: 'no script left' });
    if (toolExecutor == null) throw new Error('expected a toolExecutor in delegated mode');
    if (script.callsFirst !== true) yield { type: 'text-delta', text: 'Working. ' };
    const results: DelegatedToolResult[] = [];
    for (const call of script.calls) results.push(await toolExecutor(call));
    if (script.delayAfterCallsMs != null) await new Promise(resolve => setTimeout(resolve, script.delayAfterCallsMs));
    if (script.failAfterCalls === true) throw createAigentError({ code: 'provider_failed', message: 'connection reset', details: { retryable: true } });
    if (script.hangAfterCalls === true) {
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(createAigentError({ code: 'aborted', message: 'aborted' })), { once: true }));
    }
    yield { type: 'text-delta', text: script.answer(results) };
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 0 } };
    yield { type: 'done', finishReason: 'stop' };
  }
  return {
    id: 'loop', requests, signals, stream,
    capabilities: { streaming: true, toolCalling: true, parallelToolCalls: true, promptCaching: false, vision: false, maxContextTokens: 200_000, ownsLoop: true, supportedSettings: [...PROVIDER_SETTING_KEYS] },
  };
}

let echoRuns = 0;
const echo = defineTool({
  name: 'echo', description: 'Echo', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: true,
  describeActivity: () => ({ title: 'Echo' }), run: async ({ text }) => { echoRuns += 1; return `echo:${text}`; },
});
const write = defineTool({
  name: 'write', description: 'Write', args: z.object({ path: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true,
  describeActivity: () => ({ title: 'Write' }), run: async () => 'written',
  dryRun: async ({ path }) => [{ kind: 'write', target: path, summary: `would write ${path}`, reversible: false }],
});
const guarded = defineTool({
  name: 'guarded', description: 'Needs approval', args: z.object({}).strict(), deterministic: false, cache: false, hasSideEffects: true,
  requiresApproval: true, describeActivity: () => ({ title: 'Guarded' }), run: async () => 'ran',
});

let sideEffectRuns = 0;
const sideEffect = defineTool({
  name: 'side_effect', description: 'Writes once', args: z.object({}).strict(), deterministic: false, cache: false, hasSideEffects: true,
  describeActivity: () => ({ title: 'Side effect' }), run: async () => { sideEffectRuns += 1; return 'done'; },
});

function setup(scripts: DelegatedScript[], tools: Tool[] = [echo], resilience?: Partial<ResiliencePolicy>) {
  const provider = ownsLoopProvider(scripts);
  const store = createInMemoryStore();
  const ai = createAigent({ providers: [provider], clock, ids: sequentialIds(), store });
  const agent = ai.agent({ name: 'helper', model: 'loop:m', tools, enableFeedback: false, ...(resilience == null ? {} : { resilience }) });
  return { ai, agent, provider };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const warnings = (events: AigentEvent[]): string[] => events.flatMap(event => (event.type === 'warning' ? [event.message] : []));

describe('delegated mode (capabilities.ownsLoop)', () => {
  it('makes one provider call per turn, runs tool calls through the core executor and records the steps', async () => {
    const { ai, agent, provider } = setup([{ calls: [{ id: 'c1', name: 'echo', args: { text: 'a' } }, { id: 'c2', name: 'echo', args: { text: 'b' } }], answer: results => `Got ${results.map(({ text }) => JSON.parse(text).result).join(', ')}` }]);
    const run = agent.task({ task: 'Echo twice' });
    const events = await collect(run);
    const result = await run;
    expect(provider.requests).toHaveLength(1);
    expect(result).toMatchObject({ status: 'completed', answer: 'Working. Got echo:a, echo:b', usage: { turns: 1, toolCalls: 2 } });
    expect(events.filter(event => event.type === 'tool-result').map(event => (event as { callId: string }).callId)).toEqual(['c1', 'c2']);
    const trace = await ai.trace(result.runId);
    expect(trace?.steps.map(({ tool, callId }) => `${tool}:${callId}`)).toEqual(['echo:c1', 'echo:c2']);
    expect(warnings(events).filter(message => message.includes('runs its own tool loop'))).toHaveLength(1);
  });

  it('hands the executor the envelope text, failures included', async () => {
    let seen: DelegatedToolResult[] = [];
    const { agent } = setup([{ calls: [{ id: 'c1', name: 'echo', args: { text: 5 } }, { id: 'c2', name: 'missing', args: {} }], answer: results => { seen = results; return 'ok'; } }]);
    await agent.task({ task: 'x' });
    expect(seen.map(({ callId, isError }) => [callId, isError])).toEqual([['c1', true], ['c2', true]]);
    expect(JSON.parse(seen[0]?.text ?? '{}')).toMatchObject({ id: 'c1', ok: false, error: { category: 'validation' } });
  });

  it('applies the cache, dry runs and approvals to delegated calls', async () => {
    echoRuns = 0;
    const call = { id: 'c1', name: 'echo', args: { text: 'same' } };
    const cached = setup([{ calls: [call, { ...call, id: 'c2' }], answer: () => 'ok' }]);
    await cached.agent.task({ task: 'x' });
    expect(echoRuns).toBe(1);

    const dry = setup([{ calls: [{ id: 'w1', name: 'write', args: { path: 'a.txt' } }], answer: () => 'ok' }], [write]);
    const dryResult = await dry.agent.task({ task: 'x', dryRun: true });
    expect(dryResult.plannedEffects).toEqual([expect.objectContaining({ target: 'a.txt' })]);

    let approvalText = '';
    const approval = setup([{ calls: [{ id: 'g1', name: 'guarded', args: {} }], answer: ([result]) => { approvalText = result?.text ?? ''; return 'ok'; } }], [guarded]);
    await approval.agent.task({ task: 'x', unattended: true });
    expect(JSON.parse(approvalText)).toMatchObject({ ok: false, error: { category: 'denied' } });
  });

  it('keeps the round in the history: calls with results, then the answer', async () => {
    const { agent, provider } = setup([
      { calls: [{ id: 'c1', name: 'echo', args: { text: 'a' } }], answer: () => 'first' },
      { calls: [], answer: () => 'second' },
    ]);
    const chat = agent.chat({ persistence: 'memory' });
    await chat.send('one');
    await chat.send('two');
    const roles = provider.requests[1]?.messages.map(({ role, toolCalls }) => (toolCalls == null ? role : `${role}+calls`));
    expect(roles).toEqual(['system', 'user', 'assistant+calls', 'tool', 'assistant', 'user', 'user']);
    await chat.close();
  });

  it('propagates a stop to the provider while it waits, and settles as cancelled', async () => {
    const { agent, provider } = setup([{ calls: [{ id: 'c1', name: 'echo', args: { text: 'a' } }], answer: () => 'never', hangAfterCalls: true }]);
    const run = agent.task({ task: 'x' });
    for await (const event of run) if (event.type === 'tool-result') run.cancel();
    expect((await run).status).toBe('cancelled');
    expect(provider.signals[0]?.aborted).toBe(true);
  });
  it('never retries or falls back once a delegated call ran in the attempt, so a side effect runs once', async () => {
    sideEffectRuns = 0;
    const { agent, provider } = setup([
      { calls: [{ id: 's1', name: 'side_effect', args: {} }], answer: () => 'never', callsFirst: true, failAfterCalls: true },
      { calls: [{ id: 's2', name: 'side_effect', args: {} }], answer: () => 'retried' },
    ], [sideEffect], { baseDelayMs: 1, maxDelayMs: 1 });
    const run = agent.task({ task: 'x' });
    const events = await collect(run);
    const result = await run;
    expect(sideEffectRuns).toBe(1);
    expect(provider.requests).toHaveLength(1);
    expect(events.filter(event => event.type === 'retry')).toEqual([]);
    expect(result).toMatchObject({ status: 'failed', usage: { toolCalls: 1, retries: 0 } });
    expect(result.failure).toContain('connection reset');
  });

  it('does not time out the first event while a delegated call runs', async () => {
    sideEffectRuns = 0;
    const firstEventTimeoutMs = 30;
    const { agent, provider } = setup([
      { calls: [{ id: 's1', name: 'side_effect', args: {} }], answer: () => 'finished', callsFirst: true, delayAfterCallsMs: firstEventTimeoutMs * 3 },
    ], [sideEffect], { firstEventTimeoutMs, baseDelayMs: 1, maxDelayMs: 1 });
    const result = await agent.task({ task: 'x' });
    expect(result).toMatchObject({ status: 'completed', answer: 'finished', usage: { retries: 0 } });
    expect(provider.requests).toHaveLength(1);
    expect(sideEffectRuns).toBe(1);
  });
});
