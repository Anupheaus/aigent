import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import type { TraceRecord } from '../telemetry/run-record.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import type { AigentEvent } from './aigent-events.js';
import { createAigent } from './create-aigent.js';
import type { AigentOptions } from './aigent-types.js';
import type { Clock, IdGenerator } from './runtime-services.js';

function tickingClock(): Clock {
  let current = 1_000;
  return { now: () => { current += 1; return current; } };
}

function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

function countingReadTool(): { tool: Tool; runs(): number } {
  let runs = 0;
  const tool = defineTool({
    // Shared, so agents 'one' and 'two' meet in one entry; the default (per-agent) namespace is tested below.
    name: 'read', description: 'Read a file', args: z.object({ path: z.string() }).strict(), deterministic: true, cache: true, sharedCache: true,
    describeActivity: ({ path }) => ({ title: `Reading ${path}` }),
    run: async ({ path }) => { runs += 1; return { path, text: `contents of ${path}` }; },
  });
  return { tool, runs: () => runs };
}

const READ_TURN: FakeTurn = toolTurn([{ id: 'c1', name: 'read', args: { path: 'a.txt' } }]);

function setup(options: Partial<AigentOptions> = {}) {
  const { tool, runs } = countingReadTool();
  const provider = createFakeProvider({ turns: [READ_TURN, textTurn('one done'), READ_TURN, textTurn('two done')] });
  const ai = createAigent({ providers: [provider], clock: tickingClock(), ids: sequentialIds(), enableFeedback: false, ...options });
  const one = ai.agent({ name: 'one', model: 'fake:m', tools: [tool] });
  const two = ai.agent({ name: 'two', model: 'fake:m', tools: [tool] });
  return { ai, one, two, provider, runs };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function storedSteps(store: Store, runId: string): Promise<TraceRecord['steps']> {
  return (await store.get<TraceRecord>('traces', runId))!.value.steps;
}

describe('createAigent tool-result cache', () => {
  it('serves a second agent\'s identical deterministic call from the cache, recording the hit', async () => {
    const store = createInMemoryStore();
    const { ai, one, two, provider, runs } = setup({ store });
    const first = await one.task({ task: 'read a' });
    const secondRun = two.task({ task: 'read a' });
    const events = await collect(secondRun);
    const second = await secondRun;
    expect(runs()).toBe(1);
    expect(await storedSteps(store, first.runId)).toEqual([expect.objectContaining({ tool: 'read', cacheHit: false })]);
    const [hitStep] = await storedSteps(store, second.runId);
    expect(hitStep).toMatchObject({ tool: 'read', ok: true, cacheHit: true, savedMs: expect.any(Number) });
    // The model still receives the normal envelope.
    const toolMessage = provider.requests[3]!.messages.find(({ role }) => role === 'tool');
    expect(JSON.parse(toolMessage!.text!)).toEqual({ id: 'c1', tool: 'read', ok: true, result: { path: 'a.txt', text: 'contents of a.txt' } });
    // Activity views are still emitted for hits.
    expect(events).toContainEqual({ type: 'tool-activity', callId: 'c1', view: { title: 'Reading a.txt' } });
    const { durationMs: _first, ...firstUsage } = first.usage;
    const { durationMs: _second, ...secondUsage } = second.usage;
    expect(secondUsage).toEqual(firstUsage);
    await ai.close();
  });

  it('fills report.cache from the stored entries', async () => {
    const store = createInMemoryStore();
    const { ai, one, two } = setup({ store });
    await one.task({ task: 'read a' });
    await two.task({ task: 'read a' });
    const { cache } = await ai.report();
    expect(cache.hottest).toEqual([{ tool: 'read', key: expect.stringMatching(/^global:[0-9a-f]{64}$/), hits: 1, savedMs: expect.any(Number) }]);
    expect(cache.hitRateByTool).toEqual({ read: 0.5 });
    expect(cache.hitRateByAgent).toEqual({ one: 0, two: 1 });
  });

  it('caches inner aigent_multi calls too', async () => {
    const { tool, runs } = countingReadTool();
    const provider = createFakeProvider({
      turns: [
        READ_TURN, textTurn('done'),
        toolTurn([{ id: 'm1', name: 'aigent_multi', args: { calls: [{ id: 'inner', tool: 'read', args: { path: 'a.txt' } }] } }]), textTurn('done'),
      ],
    });
    const store = createInMemoryStore();
    const ai = createAigent({ providers: [provider], clock: tickingClock(), ids: sequentialIds(), enableFeedback: false, store });
    const agent = ai.agent({ name: 'one', model: 'fake:m', tools: [tool] });
    await agent.task({ task: 'read' });
    const multi = await agent.task({ task: 'read again' });
    expect(runs()).toBe(1);
    expect(await storedSteps(store, multi.runId)).toEqual([
      expect.objectContaining({ tool: 'aigent_multi' }),
      expect.objectContaining({ tool: 'read', parentCallId: 'm1', cacheHit: true }),
    ]);
  });

  it('caches without a runtime store, in a private in-memory store', async () => {
    const { one, two, runs } = setup();
    await one.task({ task: 'read a' });
    await two.task({ task: 'read a' });
    expect(runs()).toBe(1);
  });

  it('keeps tool results out of the runtime store when content capture is off', async () => {
    const store = createInMemoryStore();
    const { one, two, runs } = setup({ store, captureContent: false });
    await one.task({ task: 'read a' });
    await two.task({ task: 'read a' });
    expect(runs()).toBe(1);
    expect(await store.list('toolcache')).toEqual([]);
  });

  it('stamps entries with agentName, runId and recordedAt, so ai.purge removes an agent’s cached results (review I2)', async () => {
    const store = createInMemoryStore();
    const { ai, one, two, runs } = setup({ store });
    const first = await one.task({ task: 'read a' });
    const [entry] = await store.list<Record<string, unknown>>('toolcache');
    expect(entry?.value).toMatchObject({ agentName: 'one', runId: first.runId, recordedAt: expect.any(Number) });
    await ai.purge({ agentName: 'one' });
    expect(await store.list('toolcache')).toEqual([]);
    await two.task({ task: 'read a' });
    expect(runs()).toBe(2);
  });

  it('applies retention: an entry expires (and is no longer served) expiresInMs after it was recorded (review I2)', async () => {
    const store = createInMemoryStore();
    let current = 1_000;
    const clock: Clock = { now: () => current };
    const { one, two, runs } = setup({ store, clock, retention: { expiresInMs: 5_000 } });
    await one.task({ task: 'read a' });
    const [entry] = await store.list<{ recordedAt: number; expiresAt: number }>('toolcache');
    expect(entry!.value.expiresAt).toBe(entry!.value.recordedAt + 5_000);
    current += 5_000;
    await two.task({ task: 'read a' });
    expect(runs()).toBe(2);
  });

  it('keeps the cache out of the consumer store when redact is set, so nothing un-redacted is stored and nothing redacted is served (review I2)', async () => {
    const store = createInMemoryStore();
    const { one, two, runs } = setup({ store, redact: record => record });
    await one.task({ task: 'read a' });
    await two.task({ task: 'read a' });
    expect(runs()).toBe(1);
    expect(await store.list('toolcache')).toEqual([]);
  });

  it('is disabled with cache: false', async () => {
    const store = createInMemoryStore();
    const { one, two, runs } = setup({ store, cache: false });
    await one.task({ task: 'read a' });
    const second = await two.task({ task: 'read a' });
    expect(runs()).toBe(2);
    const [step] = await storedSteps(store, second.runId);
    expect(step?.cacheHit).toBeUndefined();
  });

  it('a lossy-ok cached tool returning a cyclic object never hangs a later run (review R1)', async () => {
    const cyclicTool = defineTool({
      name: 'graph', description: 'A graph', args: z.object({ id: z.string() }).strict(), deterministic: true, cache: true,
      contentKind: 'structured-data', fidelity: 'lossy-ok',
      describeActivity: ({ id }) => ({ title: `Graph ${id}` }),
      run: async () => { const node: Record<string, unknown> = { name: 'n' }; node.self = node; return node; },
    });
    const graphTurn = toolTurn([{ id: 'g1', name: 'graph', args: { id: 'x' } }]);
    const provider = createFakeProvider({ turns: [graphTurn, textTurn('one'), graphTurn, textTurn('two')] });
    const ai = createAigent({ providers: [provider], clock: tickingClock(), ids: sequentialIds(), enableFeedback: false });
    const agent = ai.agent({ name: 'one', model: 'fake:m', tools: [cyclicTool] });
    const first = await agent.task({ task: 'graph' });
    const second = await agent.task({ task: 'graph again', limits: { timeoutMs: 2_000 } });
    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    await ai.close();
  });

  it('keeps two agents’ same-named, unshared deterministic tools apart, even on one store (review I1)', async () => {
    const store = createInMemoryStore();
    const boundTo = (root: string) => defineTool({
      name: 'read_file', description: 'Read a file', args: z.object({ path: z.string() }).strict(), deterministic: true, cache: true,
      describeActivity: ({ path }) => ({ title: path }), run: async ({ path }) => `${root}/${path}`,
    });
    const turn = toolTurn([{ id: 'c1', name: 'read_file', args: { path: 'x' } }]);
    const provider = createFakeProvider({ turns: [turn, textTurn('a'), turn, textTurn('b')] });
    const ai = createAigent({ providers: [provider], clock: tickingClock(), ids: sequentialIds(), enableFeedback: false, store });
    await ai.agent({ name: 'agent-a', model: 'fake:m', tools: [boundTo('/repoA')] }).task({ task: 'read' });
    await ai.agent({ name: 'agent-b', model: 'fake:m', tools: [boundTo('/repoB')] }).task({ task: 'read' });
    const toolMessage = provider.requests[3]!.messages.find(({ role }) => role === 'tool');
    expect(JSON.parse(toolMessage!.text!)).toMatchObject({ ok: true, result: '/repoB/x' });
    await ai.close();
  });

  it('rejects invalid cache options at createAigent', () => {
    expect(() => createAigent({ providers: [createFakeProvider({ turns: [] })], cache: { maxEntries: 0 } })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
  });
});
