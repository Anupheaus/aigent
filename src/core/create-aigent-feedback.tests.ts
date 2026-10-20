import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FEEDBACK_PROMPT_ADDENDUM } from '../feedback/feedback-prompt.js';
import type { Provider, ProviderEvent, ProviderRequest } from '../providers/provider-types.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { RunRecord, TraceRecord } from '../telemetry/run-record.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import type { AigentEvent } from './aigent-events.js';
import { createAigent } from './create-aigent.js';
import type { AigentOptions } from './create-aigent.js';
import type { Clock, IdGenerator } from './runtime-services.js';
import { buildSystemPrompt } from './system-prompt.js';

const PARALLEL_RUNS = 30;
const clock: Clock = { now: () => 1_000 };
const USAGE = { inputTokens: 10, outputTokens: 5, cachedTokens: 0 };

function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function recordingEcho(seen: unknown[]) {
  return defineTool({
    name: 'echo', description: 'Echo text', args: z.object({ text: z.string() }).strict(),
    deterministic: true, cache: false, describeActivity: args => ({ title: `Echo ${args.text}` }), run: async args => { seen.push(args); return args.text; },
  });
}

/** A turn that streams some text (e.g. a directive line) and then calls tools. */
function textThenTools(text: string, calls: { id: string; name: string; args: unknown }[]): FakeTurn {
  const events: ProviderEvent[] = [{ type: 'text-delta', text }, ...calls.map((call): ProviderEvent => ({ type: 'tool-call', call }))];
  return { events: [...events, { type: 'usage', usage: USAGE }, { type: 'done', finishReason: 'tool_calls' }] };
}

interface SetupParams {
  turns: FakeTurn[];
  enableFeedback?: boolean;
  options?: Partial<AigentOptions>;
  seen?: unknown[];
}

function setup(params: SetupParams) {
  const { turns, enableFeedback, options = {}, seen = [] } = params;
  const provider = createFakeProvider({ turns });
  const store = createInMemoryStore();
  const ai = createAigent({ providers: [provider], clock, ids: sequentialIds(), store, ...options });
  const agent = ai.agent({ name: 'helper', model: 'fake:m', persona: 'Calm', tools: [recordingEcho(seen)], ...(enableFeedback == null ? {} : { enableFeedback }) });
  return { ai, agent, provider, store, seen };
}

async function storedTrace(store: ReturnType<typeof createInMemoryStore>, runId: string): Promise<TraceRecord> {
  return (await store.get<TraceRecord>('traces', runId))!.value;
}

describe('enableFeedback off', () => {
  it('sends no previous field, no aigent_feedback tool and no directive text, and the plain system prompt', async () => {
    const { agent, provider } = setup({ turns: [toolTurn([{ id: 'a', name: 'echo', args: { text: 'x' } }]), textTurn('done')], enableFeedback: false });
    await agent.task({ task: 'x' });
    const bodies = JSON.stringify(provider.requests);
    for (const absent of ['previous', 'aigent_feedback', '::aigent']) expect(bodies).not.toContain(absent);
    expect(provider.requests[0]?.messages[0]?.text).toBe(buildSystemPrompt({ persona: 'Calm' }));
    expect(provider.requests[0]?.tools.map(({ name }) => name)).toEqual(['aigent_multi', 'echo']);
  });

  it('follows createAigent({ enableFeedback }) unless the agent sets its own value', async () => {
    const off = setup({ turns: [textTurn('ok')], options: { enableFeedback: false } });
    await off.agent.task({ task: 'x' });
    expect(off.provider.requests[0]?.tools.map(({ name }) => name)).toEqual(['aigent_multi', 'echo']);
    const overridden = setup({ turns: [textTurn('ok')], options: { enableFeedback: false }, enableFeedback: true });
    await overridden.agent.task({ task: 'x' });
    expect(overridden.provider.requests[0]?.tools.map(({ name }) => name)).toEqual(['aigent_feedback', 'aigent_multi', 'echo']);
  });

  it('gives the flag a part in agentVersion', () => {
    const { ai } = setup({ turns: [] });
    const on = ai.agent({ name: 'a', model: 'fake:m', enableFeedback: true });
    const off = ai.agent({ name: 'a', model: 'fake:m', enableFeedback: false });
    expect(on.agentVersion).not.toBe(off.agentVersion);
  });
});

describe('enableFeedback on', () => {
  it('sends the addendum, the sorted aigent_feedback tool and previous on every other tool', async () => {
    const { agent, provider } = setup({ turns: [textTurn('ok')], enableFeedback: true });
    await agent.task({ task: 'x' });
    const [request] = provider.requests as [ProviderRequest];
    expect(request.messages[0]?.text).toBe(buildSystemPrompt({ persona: 'Calm', enableFeedback: true }));
    expect(request.messages[0]?.text).toContain(FEEDBACK_PROMPT_ADDENDUM);
    expect(request.tools.map(({ name }) => name)).toEqual(['aigent_feedback', 'aigent_multi', 'echo']);
    const previousIn = request.tools.map(({ name, parameters }) => ({ name, hasPrevious: 'previous' in ((parameters.properties ?? {}) as object) }));
    expect(previousIn).toEqual([{ name: 'aigent_feedback', hasPrevious: false }, { name: 'aigent_multi', hasPrevious: true }, { name: 'echo', hasPrevious: true }]);
  });

  it('strips previous before the tool runs, from the tool-call event and from recorded args, and links it to the prior step', async () => {
    const { agent, store, seen } = setup({ enableFeedback: true, turns: [
      toolTurn([{ id: 'a', name: 'echo', args: { text: 'one', previous: null } }]),
      toolTurn([{ id: 'b', name: 'echo', args: { text: 'two', previous: { success: true, answer: 'one worked' } } }]),
      textTurn('done'),
    ] });
    const run = agent.task({ task: 'x' });
    const events = await collect(run);
    const result = await run;
    expect(seen).toEqual([{ text: 'one' }, { text: 'two' }]);
    expect(events.filter(event => event.type === 'tool-call').map(event => event.type === 'tool-call' && event.args)).toEqual([{ text: 'one' }, { text: 'two' }]);
    expect(events.filter(event => event.type === 'warning')).toEqual([]);
    const { steps } = await storedTrace(store, result.runId);
    expect(steps.map(({ args, argsSummary }) => ({ args, argsSummary }))).toEqual([{ args: { text: 'one' }, argsSummary: '{"text":"one"}' }, { args: { text: 'two' }, argsSummary: '{"text":"two"}' }]);
    expect(steps[0]?.outcome).toEqual({ success: true, answer: 'one worked', source: 'previous' });
    expect(steps[1]?.outcome).toBeUndefined();
  });

  it('warns exactly once per run when later calls leave previous out, without rejecting them', async () => {
    const { agent, seen } = setup({ enableFeedback: true, turns: [
      toolTurn([{ id: 'a', name: 'echo', args: { text: '1', previous: null } }, { id: 'b', name: 'echo', args: { text: '2', previous: null } }]),
      toolTurn([{ id: 'c', name: 'echo', args: { text: '3', previous: null } }]),
      toolTurn([{ id: 'd', name: 'echo', args: { text: '4' } }]),
      textTurn('done'),
    ] });
    const events = await collect(agent.task({ task: 'x' }));
    expect(seen).toHaveLength(4);
    expect(events.filter(event => event.type === 'warning')).toEqual([{ type: 'warning', message: expect.stringMatching(/previous.*'c'.*'echo'/) }]);
  });

  it('warns about an invalid previous, ignores it and still runs the call', async () => {
    const { agent, seen, store } = setup({ enableFeedback: true, turns: [
      toolTurn([{ id: 'a', name: 'echo', args: { text: '1' } }]),
      toolTurn([{ id: 'b', name: 'echo', args: { text: '2', previous: { success: 'yes', answer: 'x' } } }]),
      textTurn('done'),
    ] });
    const run = agent.task({ task: 'x' });
    const events = await collect(run);
    expect(seen).toEqual([{ text: '1' }, { text: '2' }]);
    expect(events.filter(event => event.type === 'warning')).toEqual([{ type: 'warning', message: expect.stringMatching(/Ignored invalid previous on call 'b'.*success/) }]);
    expect((await storedTrace(store, (await run).runId)).steps[0]?.outcome).toBeUndefined();
  });

  it('stores one outcome when a directive and previous report the same step, and the directive wins', async () => {
    const { agent, store } = setup({ enableFeedback: true, turns: [
      toolTurn([{ id: 'a', name: 'echo', args: { text: '1', previous: null } }]),
      textThenTools('::aigent outcome {"success":true,"answer":"from directive"}\n', [{ id: 'b', name: 'echo', args: { text: '2', previous: { success: false, answer: 'from previous' } } }]),
      textTurn('done'),
    ] });
    const result = await agent.task({ task: 'x' });
    const { steps } = await storedTrace(store, result.runId);
    expect(steps.map(({ outcome }) => outcome)).toEqual([{ success: true, answer: 'from directive', source: 'directive' }, undefined]);
    expect((await store.get<RunRecord>('runs', result.runId))?.value.outcomeSummary).toEqual({ claimedSuccess: 1, claimedFailure: 0 });
  });

  it('attaches previous in a parallel turn to the step started just before the reporting call', async () => {
    const { agent, store } = setup({ enableFeedback: true, turns: [
      toolTurn([{ id: 'a', name: 'echo', args: { text: '1', previous: null } }, { id: 'b', name: 'echo', args: { text: '2', previous: null } }]),
      toolTurn([
        { id: 'c', name: 'echo', args: { text: '3', previous: { success: true, answer: 'b done' } } },
        { id: 'd', name: 'echo', args: { text: '4', previous: { success: false, answer: 'c pending' } } },
      ]),
      textTurn('::aigent outcome {"success":true,"answer":"d done"}\nAll done'),
    ] });
    const result = await agent.task({ task: 'x' });
    expect(result.answer).toBe('All done');
    const { steps } = await storedTrace(store, result.runId);
    expect(steps.map(({ callId, outcome }) => [callId, outcome?.answer, outcome?.source])).toEqual([
      ['a', undefined, undefined], ['b', 'b done', 'previous'], ['c', 'c pending', 'previous'], ['d', 'd done', 'directive'],
    ]);
    expect((await store.get<RunRecord>('runs', result.runId))?.value.outcomeSummary).toEqual({ claimedSuccess: 2, claimedFailure: 1 });
  });

  it('carries previous on aigent_multi at the top level only', async () => {
    const { agent, store, seen } = setup({ enableFeedback: true, turns: [
      toolTurn([{ id: 'a', name: 'echo', args: { text: '1', previous: null } }]),
      toolTurn([{ id: 'm', name: 'aigent_multi', args: { previous: { success: true, answer: 'a ok' }, calls: [{ id: 'x', tool: 'echo', args: { text: '2' } }] } }]),
      textTurn('done'),
    ] });
    const result = await agent.task({ task: 'x' });
    expect(result.errors).toEqual([]);
    expect(seen).toEqual([{ text: '1' }, { text: '2' }]);
    expect((await storedTrace(store, result.runId)).steps[0]?.outcome).toEqual({ success: true, answer: 'a ok', source: 'previous' });
  });

  it('stores aigent_feedback entries in the feedback collection with the run identity', async () => {
    const { agent, store } = setup({ enableFeedback: true, turns: [
      toolTurn([{ id: 'f1', name: 'aigent_feedback', args: { entries: [{ kind: 'hard', text: 'Search was slow', relatedTool: 'echo' }, { kind: 'easy', text: 'Echo is clear', relatedTool: null }] } }]),
      textTurn('done'),
    ] });
    const result = await agent.task({ task: 'x', scope: { tenant: 't1' } });
    const stored = await store.list('feedback');
    expect(stored.map(({ key }) => key).sort()).toEqual([`${result.runId}:f1:0`, `${result.runId}:f1:1`]);
    expect((await store.get('feedback', `${result.runId}:f1:0`))?.value).toEqual({
      schemaVersion: 1, runId: result.runId, agentName: 'helper', instanceId: agent.instanceId, mode: 'task', agentVersion: agent.agentVersion,
      scope: { tenant: 't1' }, recordedAt: 1_000, kind: 'agent', callId: 'f1', index: 0, entry: { kind: 'hard', text: 'Search was slow', relatedTool: 'echo' },
    });
  });

  it('passes aigent_feedback entries through redact like every other record', async () => {
    const SECRET = 'customer-42';
    const redacted: string[] = [];
    const { agent, store } = setup({
      enableFeedback: true,
      options: { redact: ({ collection, key, value }) => { redacted.push(collection); return { collection, key, value: JSON.parse(JSON.stringify(value).replaceAll(SECRET, '[x]')) }; } },
      turns: [toolTurn([{ id: 'f1', name: 'aigent_feedback', args: { entries: [{ kind: 'hard', text: `Data for ${SECRET} was missing`, relatedTool: null }] } }]), textTurn('done')],
    });
    const result = await agent.task({ task: 'x' });
    expect([...new Set(redacted)].sort()).toEqual(['feedback', 'responses', 'runs', 'traces']);
    expect((await store.get('feedback', `${result.runId}:f1:0`))?.value).toMatchObject({ entry: { text: 'Data for [x] was missing' } });
    expect(JSON.stringify(await store.list('feedback'))).not.toContain(SECRET);
  });

  it('stores nothing from aigent_feedback when telemetry is disabled', async () => {
    const { agent, store } = setup({ enableFeedback: true, turns: [toolTurn([{ id: 'f1', name: 'aigent_feedback', args: { entries: [{ kind: 'easy', text: 'x', relatedTool: null }] } }]), textTurn('done')] });
    await agent.task({ task: 'x', disableTelemetry: true });
    expect(await store.list('feedback')).toEqual([]);
  });

  it('loses no feedback entries across 30 concurrent runs of one agent', async () => {
    // Answers each request by its content, since concurrent runs interleave their requests.
    const provider: Provider = {
      id: 'fake', capabilities: createFakeProvider({ turns: [] }).capabilities,
      stream: async function* (request) {
        const hasToolResult = request.messages.some(({ role }) => role === 'tool');
        const turn = hasToolResult
          ? textTurn('done')
          : toolTurn([{ id: 'f1', name: 'aigent_feedback', args: { entries: [{ kind: 'easy', text: 'one', relatedTool: null }, { kind: 'hard', text: 'two', relatedTool: null }] } }]);
        yield* turn.events;
      },
    };
    const store = createInMemoryStore();
    const ai = createAigent({ providers: [provider], clock, ids: sequentialIds(), store });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', enableFeedback: true });
    const results = await Promise.all(Array.from({ length: PARALLEL_RUNS }, () => agent.task({ task: 'x' })));
    await ai.close();
    expect((await store.list('feedback')).length).toBe(PARALLEL_RUNS * 2);
    expect(new Set((await store.list<{ runId: string }>('feedback')).map(({ value }) => value.runId))).toEqual(new Set(results.map(({ runId }) => runId)));
  });
});
