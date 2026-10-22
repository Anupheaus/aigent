import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { CompareAndSetParams, Store } from '../store/store-types.js';
import type { RunRecord, TraceRecord } from '../telemetry/run-record.js';
import type { Redact } from '../telemetry/redact.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeProvider, FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { defineBatchTool } from '../tools/define-batch-tool.js';
import type { Tool } from '../tools/tool-types.js';
import { createAigentError } from './aigent-error.js';
import type { AigentEvent } from './aigent-events.js';
import { createAigent } from './create-aigent.js';
import type { AigentOptions } from './aigent-types.js';
import type { Clock, IdGenerator } from './runtime-services.js';

const PARALLEL_RUNS = 30;
const SECRET = 'top-secret';

/** Every call moves time on by 1 ms, so timings are deterministic and strictly ordered. */
function tickingClock(start = 1_000): Clock {
  let current = start;
  return { now: () => { current += 1; return current; } };
}

function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const echoTool = defineTool({
  name: 'echo', description: 'Echo text', args: z.object({ text: z.string() }).strict(),
  deterministic: true, cache: false, describeActivity: args => ({ title: `Echo ${args.text}` }), run: async args => args.text,
});

const readAll = defineBatchTool({
  name: 'read_all', description: 'Read several', item: z.object({ id: z.string() }).strict(), maxItems: 5, deterministic: true, cache: false,
  describeActivity: () => ({ title: 'read' }), runItem: async batchItem => { if (batchItem.id === 'bad') throw new Error('unreadable'); return `${batchItem.id} contents`; },
});

const bigTool = defineTool({
  name: 'big', description: 'Returns a lot', args: z.object({}).strict(), deterministic: true, cache: false, maxResultTokens: 5,
  describeActivity: () => ({ title: 'big' }), run: async () => 'x'.repeat(400),
});

/** Every value handed to `compareAndSet`, so tests can see exactly what reached the store. */
function recordingStore(base: Store = createInMemoryStore()): { store: Store; written: CompareAndSetParams<unknown>[] } {
  const written: CompareAndSetParams<unknown>[] = [];
  return { written, store: { ...base, compareAndSet: params => { written.push(structuredClone(params)); return base.compareAndSet(params); } } };
}

interface SetupParams {
  turns: FakeTurn[];
  tools?: Tool[];
  options?: Partial<Omit<AigentOptions, 'store'>> & { store?: Store };
  provider?: FakeProvider;
}

function setup(params: SetupParams) {
  const { turns, tools = [echoTool, readAll, bigTool], options = {}, provider = createFakeProvider({ turns }) } = params;
  const store = options.store ?? createInMemoryStore();
  const ai = createAigent({ providers: [provider], clock: tickingClock(), ids: sequentialIds(), store, ...options });
  const agent = ai.agent({ name: 'helper', model: 'fake:m', tools, version: 'v7' });
  return { ai, agent, store, provider };
}

async function storedRun(store: Store, runId: string): Promise<RunRecord> {
  return (await store.get<RunRecord>('runs', runId))!.value;
}

async function storedTrace(store: Store, runId: string): Promise<TraceRecord> {
  return (await store.get<TraceRecord>('traces', runId))!.value;
}

describe('run records and traces', () => {
  it('stores a versioned run record and adds responseId to the result and the done event', async () => {
    const { agent, store } = setup({ turns: [toolTurn([{ id: 'c1', name: 'echo', args: { text: 'hi' } }]), textTurn('The answer')] });
    const run = agent.task({ task: 'Say hi', label: 'step-1', scope: { tenant: 't1', userId: 'u1' }, unattended: true });
    const events = await collect(run);
    const result = await run;
    expect(result.responseId).toMatch(/^resp_/);
    expect(events.at(-1)).toEqual({ type: 'done', status: 'completed', responseId: result.responseId });
    expect(await storedRun(store, result.runId)).toMatchObject({
      schemaVersion: 1, runId: result.runId, responseId: result.responseId, agentName: 'helper', instanceId: agent.instanceId, mode: 'task',
      agentVersion: agent.agentVersion, version: 'v7', label: 'step-1', scope: { tenant: 't1', userId: 'u1' }, model: 'fake:m', unattended: true,
      status: 'completed', stepCount: 1, failureCount: 0, task: 'Say hi', answer: 'The answer', usage: result.usage,
    });
  });

  it('records ordered steps with turn numbers, start times and timings from a scripted run', async () => {
    const { agent, store } = setup({ turns: [
      toolTurn([{ id: 'a', name: 'echo', args: { text: '1' } }, { id: 'b', name: 'echo', args: { text: '2' } }]),
      toolTurn([{ id: 'c', name: 'echo', args: { text: '3' } }]),
      textTurn('done'),
    ] });
    const result = await agent.task({ task: 'x' });
    const { steps, schemaVersion, agentVersion, mode } = await storedTrace(store, result.runId);
    expect({ schemaVersion, agentVersion, mode }).toEqual({ schemaVersion: 1, agentVersion: (await storedRun(store, result.runId)).agentVersion, mode: 'task' });
    expect(steps.map(({ index, turn, callId, tool, ok }) => ({ index, turn, callId, tool, ok }))).toEqual([
      { index: 0, turn: 1, callId: 'a', tool: 'echo', ok: true },
      { index: 1, turn: 1, callId: 'b', tool: 'echo', ok: true },
      { index: 2, turn: 2, callId: 'c', tool: 'echo', ok: true },
    ]);
    const starts = steps.map(step => step.startedAtMs);
    expect([...starts].sort((left, right) => left - right)).toEqual(starts);
    expect(new Set(starts).size).toBe(3);
    for (const step of steps) expect(step).toMatchObject({ argsSummary: expect.stringMatching(/^\{"text":"\d"\}$/), resultBytes: 3, resultTokens: 1, truncated: false });
    const { timings } = await storedRun(store, result.runId);
    expect(timings.startedAt).toBeLessThan(starts[0]!);
    expect(timings.firstTokenMs).toBeGreaterThan(0);
    expect(timings.durationMs).toBe(result.usage.durationMs);
    expect(timings.modelMs).toBeGreaterThan(0);
    expect(timings.toolMs).toBe(steps.reduce((total, step) => total + step.durationMs, 0));
  });

  it('reports time waiting for the scheduler as queuedMs, not as model time', async () => {
    let now = 1_000;
    const QUEUE_WAIT_MS = 250;
    const STREAM_MS = 40;
    const clock: Clock = { now: () => now };
    const scheduler = {
      acquire: async () => { now += QUEUE_WAIT_MS; return { release: () => undefined }; },
      reportRateLimit: () => undefined, reportUsage: () => undefined, snapshot: () => ({}),
    };
    const provider = createFakeProvider({ turns: [textTurn('ok')] });
    const streaming: FakeProvider = { ...provider, stream: async function* (request, signal) { now += STREAM_MS; yield* provider.stream(request, signal); } };
    const { agent, store } = setup({ turns: [], provider: streaming, options: { clock, scheduler } });
    const result = await agent.task({ task: 'x' });
    expect((await storedRun(store, result.runId)).timings).toMatchObject({ queuedMs: QUEUE_WAIT_MS, modelMs: STREAM_MS, firstTokenMs: QUEUE_WAIT_MS + STREAM_MS });
  });

  it('links aigent_multi inner calls to their parent and records batch partial failures', async () => {
    const { agent, store } = setup({ turns: [
      toolTurn([{ id: 'm1', name: 'aigent_multi', args: { calls: [
        { id: 'x', tool: 'read_all', args: { items: [{ id: 'ok' }, { id: 'bad' }, { id: 'fine' }] } },
        { id: 'y', tool: 'echo', args: { text: 5 } },
      ] } }]),
      textTurn('done'),
    ] });
    const result = await agent.task({ task: 'x' });
    const { steps } = await storedTrace(store, result.runId);
    expect(steps).toEqual([
      expect.objectContaining({ index: 0, callId: 'm1', tool: 'aigent_multi', ok: true }),
      expect.objectContaining({ index: 1, callId: 'x', parentCallId: 'm1', tool: 'read_all', ok: true, itemFailures: 1, itemTotal: 3 }),
      expect.objectContaining({ index: 2, callId: 'y', parentCallId: 'm1', tool: 'echo', ok: false, errorCategory: 'validation', errorCode: 'invalid_arguments' }),
    ]);
    expect((await storedRun(store, result.runId)).failureCount).toBe(2);
  });

  it('truncates an oversize result for the model and flags it on the step', async () => {
    const { agent, store, provider } = setup({ turns: [toolTurn([{ id: 'b1', name: 'big', args: {} }]), textTurn('done')] });
    const result = await agent.task({ task: 'x' });
    const visible = JSON.parse(provider.requests[1]!.messages.at(-2)!.text!);
    expect(visible.result).toEqual({ truncated: true, note: 'Result truncated to ~5 tokens (was ~101); narrow the request or page through it.', preview: `"${'x'.repeat(19)}` });
    expect((await storedTrace(store, result.runId)).steps[0]).toMatchObject({ truncated: true, resultBytes: 402, resultTokens: 101 });
  });

  it('records refused calls (unknown tool, invalid args, over the limit) as failed steps', async () => {
    const { agent, store } = setup({ turns: [toolTurn([
      { id: 'u', name: 'nope', args: {} }, { id: 'v', name: 'echo', args: { text: 1 } }, { id: 'ok', name: 'echo', args: { text: 'a' } }, { id: 'l', name: 'echo', args: { text: 'b' } },
    ]), textTurn('done')] });
    const result = await agent.task({ task: 'x', limits: { maxToolCalls: 3 } });
    expect((await storedTrace(store, result.runId)).steps.map(({ callId, ok, errorCode }) => ({ callId, ok, errorCode }))).toEqual([
      { callId: 'u', ok: false, errorCode: 'unknown_tool' },
      { callId: 'v', ok: false, errorCode: 'invalid_arguments' },
      { callId: 'ok', ok: true, errorCode: undefined },
      { callId: 'l', ok: false, errorCode: 'tool_call_limit' },
    ]);
  });

  it('stamps expiresAt from the retention option', async () => {
    const { agent, store } = setup({ turns: [textTurn('ok')], options: { retention: { expiresInMs: 60_000 } } });
    const result = await agent.task({ task: 'x' });
    const run = await storedRun(store, result.runId);
    expect(run.expiresAt).toBe(run.recordedAt + 60_000);
    expect((await storedTrace(store, result.runId)).expiresAt).toBe(run.expiresAt);
  });

  it('rejects an invalid retention option at createAigent', () => {
    expect(() => createAigent({ providers: [createFakeProvider({ turns: [] })], retention: { expiresInMs: -1 } })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringContaining('expiresInMs') }));
  });
});

describe('content capture and redaction', () => {
  it('stores no task, answer or argument values with captureContent: false', async () => {
    const { written, store } = recordingStore();
    const { agent } = setup({ turns: [toolTurn([{ id: 'c1', name: 'echo', args: { text: SECRET } }]), textTurn(`answer ${SECRET}`)], options: { store, captureContent: false } });
    const result = await agent.task({ task: `task ${SECRET}` });
    expect(written.map(({ collection }) => collection).sort()).toEqual(['responses', 'runs', 'traces']);
    expect(JSON.stringify(written)).not.toContain(SECRET);
    const run = await storedRun(store, result.runId);
    expect(run).not.toHaveProperty('task');
    expect(run).not.toHaveProperty('answer');
    expect((await storedTrace(store, result.runId)).steps[0]).toMatchObject({ argsSummary: '{"text":"<string>"}' });
  });

  it('counts repeats by argument values, not shapes, with captureContent: false', async () => {
    const { store } = recordingStore();
    const calls = ['a.txt', 'b.txt', 'a.txt'].map((text, position) => ({ id: `c${position}`, name: 'echo', args: { text } }));
    const { agent } = setup({ turns: [toolTurn(calls), textTurn('done')], options: { store, captureContent: false } });
    const result = await agent.task({ task: 'x' });
    expect((await storedRun(store, result.runId)).toolUse).toEqual({ calls: 3, items: 3, repeats: 1 });
    expect(JSON.stringify((await storedTrace(store, result.runId)).steps)).not.toContain('a.txt');
  });

  it('applies redact to every record of every collection, provider options of fallbacks included', async () => {
    const { written, store } = recordingStore();
    const overloaded = createAigentError({ code: 'provider_failed', message: 'HTTP 503', details: { status: 503, retryable: true } });
    const primary = createFakeProvider({ id: 'first', turns: [{ events: [], failBeforeEvents: overloaded }, { events: [], failBeforeEvents: overloaded }] });
    const fallback = createFakeProvider({ id: 'second', turns: [toolTurn([{ id: 'c1', name: 'echo', args: { text: SECRET } }]), textTurn(`answer ${SECRET}`)] });
    const seen: string[] = [];
    const redact: Redact = ({ collection, key, value }) => {
      seen.push(`${collection}/${key}`);
      return { collection, key, value: JSON.parse(JSON.stringify(value).replaceAll(SECRET, '[redacted]')) };
    };
    const ai = createAigent({
      providers: [primary, fallback], clock: tickingClock(), ids: sequentialIds(), store, redact,
      modelSettings: { providerOptions: { first: { user: SECRET }, second: { user: SECRET } } },
    });
    const agent = ai.agent({ name: 'helper', model: 'first:m', fallbackModels: ['second:m'], resilience: { maxRetries: 0 }, tools: [echoTool] });
    const result = await agent.task({ task: `task ${SECRET}` });
    expect(result.status).toBe('completed');
    expect(seen.sort()).toEqual([`responses/${result.responseId}`, `runs/${result.runId}`, `traces/${result.runId}`]);
    expect(written.map(({ collection }) => collection).sort()).toEqual(['responses', 'runs', 'traces']);
    expect(JSON.stringify(written)).not.toContain(SECRET);
    const run = await storedRun(store, result.runId);
    expect(run.settings.providerOptions).toEqual({ user: '[redacted]' });
    expect(run.fallbacks?.[0]?.settings.providerOptions).toEqual({ user: '[redacted]' });
  });

  it('writes nothing for a run whose redact hook throws, and says so in a warning', async () => {
    const { written, store } = recordingStore();
    const { agent } = setup({ turns: [textTurn(SECRET)], options: { store, redact: () => { throw new Error('redactor offline'); } } });
    const run = agent.task({ task: SECRET });
    const events = await collect(run);
    expect((await run).status).toBe('completed');
    expect(written).toEqual([]);
    expect(events).toContainEqual({ type: 'warning', message: expect.stringMatching(/^Could not save run record: .*redactor offline/) });
  });
});

describe('telemetry persistence', () => {
  it('turns a store failure into one warning, completes the run, and keeps later writes working', async () => {
    const memory = createInMemoryStore();
    let failuresLeft = 2;
    const flaky: Store = { ...memory, compareAndSet: async params => { if (failuresLeft > 0) { failuresLeft -= 1; throw new Error('disk full'); } return memory.compareAndSet(params); } };
    const { agent } = setup({ turns: [textTurn('first'), textTurn('second')], options: { store: flaky } });
    const firstRun = agent.task({ task: 'x' });
    const events = await collect(firstRun);
    expect((await firstRun).status).toBe('completed');
    const warnings = events.filter(event => event.type === 'warning');
    expect(warnings).toEqual([{ type: 'warning', message: expect.stringMatching(/^Could not save run record: .*disk full/) }]);
    const second = await agent.task({ task: 'y' });
    expect(await memory.get('runs', second.runId)).toBeDefined();
    expect(await memory.get('traces', second.runId)).toBeDefined();
  });

  it('keeps every record of 30 parallel runs of one agent', async () => {
    const turns = Array.from({ length: PARALLEL_RUNS }, () => textTurn('ok'));
    const { agent, store, ai } = setup({ turns });
    const results = await Promise.all(Array.from({ length: PARALLEL_RUNS }, (_, runNumber) => agent.task({ task: `task ${runNumber}` })));
    await ai.close();
    expect((await store.list('runs')).length).toBe(PARALLEL_RUNS);
    expect((await store.list('traces')).length).toBe(PARALLEL_RUNS);
    expect(new Set((await store.list<RunRecord>('runs')).map(record => record.value.runId))).toEqual(new Set(results.map(result => result.runId)));
  });

  it('writes nothing with disableTelemetry but still streams activity', async () => {
    const { written, store } = recordingStore();
    const { agent } = setup({ turns: [toolTurn([{ id: 'c1', name: 'echo', args: { text: 'hi' } }]), textTurn('ok')], options: { store } });
    const run = agent.task({ task: 'x', disableTelemetry: true });
    const events = await collect(run);
    expect(written).toEqual([]);
    expect(events).toContainEqual({ type: 'tool-activity', callId: 'c1', view: { title: 'Echo hi' } });
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
  });
});

describe('ai.trace and ai.purge', () => {
  it('returns a run with its steps, and undefined for an unknown run', async () => {
    const { agent, ai } = setup({ turns: [toolTurn([{ id: 'c1', name: 'echo', args: { text: 'hi' } }]), textTurn('ok')] });
    const result = await agent.task({ task: 'x' });
    const trace = await ai.trace(result.runId);
    expect(trace?.run).toMatchObject({ runId: result.runId, responseId: result.responseId, stepCount: 1 });
    expect(trace?.steps).toEqual([expect.objectContaining({ callId: 'c1', tool: 'echo', ok: true })]);
    expect(await ai.trace('run_missing')).toBeUndefined();
  });

  it('returns undefined from trace without a store', async () => {
    const ai = createAigent({ providers: [createFakeProvider({ turns: [] })] });
    expect(await ai.trace('run_1')).toBeUndefined();
  });

  it('purges through the store and reports how many records went', async () => {
    const { agent, ai, store } = setup({ turns: [textTurn('a'), textTurn('b')] });
    const first = await agent.task({ task: 'x' });
    const second = await agent.task({ task: 'y' });
    // The run record, its trace and its responses index entry.
    expect(await ai.purge({ runId: first.runId })).toBe(3);
    expect(await ai.trace(first.runId)).toBeUndefined();
    expect(await store.get('runs', second.runId)).toBeDefined();
  });

  it('rejects purge clearly when the store cannot purge, when there is no store, and for an empty filter', async () => {
    const { purge: _unused, ...withoutPurge } = createInMemoryStore();
    const noPurge = createAigent({ providers: [createFakeProvider({ turns: [] })], store: withoutPurge });
    await expect(noPurge.purge({ agentName: 'helper' })).rejects.toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('does not implement purge') }));
    const noStore = createAigent({ providers: [createFakeProvider({ turns: [] })] });
    await expect(noStore.purge({ agentName: 'helper' })).rejects.toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('no store') }));
    const { ai } = setup({ turns: [] });
    await expect(ai.purge({})).rejects.toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('at least one') }));
  });
});
