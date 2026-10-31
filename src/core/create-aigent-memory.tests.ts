import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MEMORY_PROMPT_ADDENDUM } from '../memory/memory-prompt.js';
import { answerEvents, callEvents, createRespondingProvider, hasToolResult, requestText, storedMemories } from '../memory/memory.test-support.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import type { RunRecord, TraceRecord } from '../telemetry/run-record.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import type { AigentOptions } from './aigent-types.js';
import type { AgentDefinition } from './agent-types.js';
import { createAigent } from './create-aigent.js';
import type { IdGenerator } from './runtime-services.js';

const PARALLEL_RUNS = 50;
const SHARED_NOTES = 25;
const CAP = 40;
const NOTE = { kind: 'fact', text: 'The API lives in apps/api', tags: ['api'], pinned: null };

function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

function lookupTool(seen: unknown[]) {
  return defineTool({
    name: 'lookup', description: 'Look a key up', args: z.object({ key: z.string() }).strict(),
    deterministic: true, cache: true, describeActivity: args => ({ title: `Look up ${args.key}` }), run: async args => { seen.push(args); return `value of ${args.key}`; },
  });
}

interface SetupParams {
  turns: FakeTurn[];
  options?: Partial<AigentOptions>;
  agent?: Partial<AgentDefinition>;
  store?: Store;
}

function setup(params: SetupParams) {
  const { turns, options = {}, agent: definition = {}, store = createInMemoryStore() } = params;
  const seen: unknown[] = [];
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], clock: { now: () => 5_000 }, ids: sequentialIds(), store, enableFeedback: false, volatile: { dateTime: false }, ...options });
  const agent = ai.agent({ name: 'helper', model: 'fake:m', tools: [lookupTool(seen)], ...definition });
  return { ai, agent, provider, store, seen };
}

const memoryCall = (memory: unknown) => toolTurn([{ id: 'c1', name: 'lookup', args: { key: 'k', memory } }]);

describe('memory disabled', () => {
  it('sends byte-identical requests with memory off, false or absent, and no memory field or addendum', async () => {
    const turns = (): FakeTurn[] => [toolTurn([{ id: 'c1', name: 'lookup', args: { key: 'k' } }]), textTurn('done')];
    const absent = setup({ turns: turns() });
    const off = setup({ turns: turns(), options: { memory: false } });
    const agentOff = setup({ turns: turns(), options: { memory: true }, agent: { memory: false } });
    for (const { agent } of [absent, off, agentOff]) await agent.task({ task: 'look k up' });
    const bodies = [absent, off, agentOff].map(({ provider }) => JSON.stringify(provider.requests));
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
    expect(bodies[0]).not.toContain('memory');
    expect(absent.agent.agentVersion).toBe(off.agent.agentVersion);
  });
});

describe('memory enabled', () => {
  it('adds the addendum and the field, strips it before the tool runs and the trace records, and saves it', async () => {
    const { agent, provider, store, seen } = setup({ turns: [memoryCall([NOTE]), textTurn('done')], options: { memory: { scope: 'agent' } } });
    const result = await agent.task({ task: 'look k up' });
    expect(provider.requests[0]?.messages[0]?.text).toContain(MEMORY_PROMPT_ADDENDUM);
    expect(provider.requests[0]?.tools.find(({ name }) => name === 'lookup')?.parameters).toMatchObject({ properties: { memory: { type: ['array', 'null'] } } });
    expect(seen).toEqual([{ key: 'k' }]);
    const trace = (await store.get<TraceRecord>('traces', result.runId))?.value;
    expect(trace?.steps[0]?.args).toEqual({ key: 'k' });
    expect(trace?.steps[0]?.argsSummary).not.toContain('memory');
    expect(trace?.steps[0]?.memory).toEqual({ saved: 1, rejected: 0 });
    const run = (await store.get<RunRecord>('runs', result.runId))?.value;
    expect(run).toMatchObject({ memorySaved: 1, memoryEvicted: 0 });
    expect((await storedMemories(store)).map(({ text, agentName, scopeKey, source }) => ({ text, agentName, scopeKey, source }))).toEqual([
      { text: 'The API lives in apps/api', agentName: 'helper', scopeKey: 'agent', source: { runId: result.runId, callId: 'c1', origin: 'tool-call' } },
    ]);
  });

  it('keeps the cache key: the same call without memory is served from the cache', async () => {
    const { agent, store, seen } = setup({ turns: [memoryCall([NOTE]), textTurn('one'), toolTurn([{ id: 'c2', name: 'lookup', args: { key: 'k', memory: null } }]), textTurn('two')], options: { memory: { scope: 'agent' } } });
    await agent.task({ task: 'first' });
    const second = await agent.task({ task: 'second' });
    expect(seen).toHaveLength(1);
    expect((await store.get<TraceRecord>('traces', second.runId))?.value.steps[0]?.cacheHit).toBe(true);
  });

  it('warns precisely about rejected notes and still runs the tool', async () => {
    const tooMany = [NOTE, { ...NOTE, text: 'second' }, { kind: 'fact', text: 'x'.repeat(301), tags: null, pinned: null }];
    const { agent, store, seen } = setup({ turns: [memoryCall(tooMany), textTurn('done')], options: { memory: { maxPerCall: 2 } } });
    const run = agent.task({ task: 't' });
    const warnings: string[] = [];
    for await (const event of run) if (event.type === 'warning') warnings.push(event.message);
    const result = await run;
    expect(seen).toEqual([{ key: 'k' }]);
    expect(warnings).toContain("Memory on call 'c1' to 'lookup': 3 memory notes sent but at most 2 are accepted per call; notes 3 were not saved");
    expect((await storedMemories(store)).map(({ text }) => text).sort()).toEqual(['The API lives in apps/api', 'second']);
    expect((await store.get<TraceRecord>('traces', result.runId))?.value.steps[0]?.memory).toEqual({ saved: 2, rejected: 1 });
  });

  it('saves no notes of a call a toolCall guardrail blocked, and says why', async () => {
    const { agent, store, seen } = setup({ turns: [memoryCall([NOTE]), textTurn('done')], options: { memory: true, guardrails: { builtins: { scope: { denyTools: ['lookup'] } } } } });
    const run = agent.task({ task: 't' });
    const warnings: string[] = [];
    for await (const event of run) if (event.type === 'warning') warnings.push(event.message);
    const result = await run;
    expect(seen).toEqual([]);
    expect(await storedMemories(store)).toEqual([]);
    expect(warnings).toContain("Memory on call 'c1' to 'lookup' was not saved: the call was not run");
    expect((await store.get<TraceRecord>('traces', result.runId))?.value.steps[0]?.memory).toEqual({ saved: 0, rejected: 1 });
    expect((await store.get<RunRecord>('runs', result.runId))?.value).toMatchObject({ memorySaved: 0 });
  });

  it('saves no notes of a call to an unknown tool, with invalid arguments or past the call limit', async () => {
    const { agent, store } = setup({
      turns: [toolTurn([
        { id: 'c1', name: 'no_such_tool', args: { memory: [{ ...NOTE, text: 'from an unknown tool' }] } },
        { id: 'c2', name: 'lookup', args: { wrong: 1, memory: [{ ...NOTE, text: 'from invalid arguments' }] } },
        { id: 'c3', name: 'lookup', args: { key: 'k', memory: [{ ...NOTE, text: 'from an admitted call' }] } },
        { id: 'c4', name: 'lookup', args: { key: 'j', memory: [{ ...NOTE, text: 'from a call past the limit' }] } },
      ]), textTurn('done')],
      options: { memory: true },
      agent: { limits: { maxToolCalls: 3 } },
    });
    await agent.task({ task: 't' });
    expect((await storedMemories(store)).map(({ text }) => text)).toEqual(['from an admitted call']);
  });

  it('saves no notes of a call whose approval was denied', async () => {
    const seen: unknown[] = [];
    const approved = defineTool({
      name: 'lookup', description: 'Look a key up', args: z.object({ key: z.string() }).strict(), requiresApproval: true,
      deterministic: false, cache: false, describeActivity: args => ({ title: `Look up ${args.key}` }), run: async args => { seen.push(args); return 'value'; },
    });
    const { agent, store } = setup({ turns: [memoryCall([NOTE]), textTurn('done')], options: { memory: true }, agent: { tools: [approved] } });
    await agent.task({ task: 't', unattended: true });
    expect(seen).toEqual([]);
    expect(await storedMemories(store)).toEqual([]);
  });

  it('passes memory writes through the runtime redact', async () => {
    const secret = ['hun', 'ter2'].join('');
    const { agent, store } = setup({
      turns: [memoryCall([{ ...NOTE, text: `The password is ${secret}` }]), textTurn('done')],
      options: { memory: true, redact: record => (record.collection === 'memory' ? { ...record, value: JSON.parse(JSON.stringify(record.value).replaceAll(secret, '[redacted]')) } : record) },
    });
    await agent.task({ task: 't' });
    const [entry] = await storedMemories(store);
    expect(entry?.text).toBe('The password is [redacted]');
    expect(JSON.stringify(await store.list('memory'))).not.toContain(secret);
  });

  it('writes nothing in a dry run or with disableTelemetry', async () => {
    for (const input of [{ dryRun: true }, { disableTelemetry: true }]) {
      const { agent, store } = setup({ turns: [memoryCall([NOTE]), textTurn('done')], options: { memory: true } });
      await agent.task({ task: 't', ...input });
      expect(await storedMemories(store)).toEqual([]);
    }
  });

  it('refuses memory without a store or with captureContent off', () => {
    const provider = createFakeProvider({ turns: [] });
    const bare = createAigent({ providers: [provider] });
    expect(() => bare.agent({ name: 'a', model: 'fake:m', memory: true })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
    const noContent = createAigent({ providers: [provider], store: createInMemoryStore(), captureContent: false, memory: true });
    expect(() => noContent.agent({ name: 'a', model: 'fake:m' })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringContaining('captureContent') }));
    expect(() => createAigent({ providers: [provider], memory: { maxPerCall: 0 } })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
  });

  it('refuses interface scope without a key, for tasks and chats', () => {
    const { agent } = setup({ turns: [], options: { memory: { scope: 'interface' } } });
    expect(() => agent.task({ task: 't' })).toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('memoryScopeKey') }));
    expect(() => agent.chat({})).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  it('keys memories on the scope: interface key, chat session, a task as its own session', async () => {
    const iface = setup({ turns: [memoryCall([NOTE]), textTurn('done')], options: { memory: { scope: 'interface' } } });
    await iface.agent.task({ task: 't', memoryScopeKey: 'slack' });
    expect((await storedMemories(iface.store)).map(({ scopeKey }) => scopeKey)).toEqual(['interface:slack']);
    const session = setup({ turns: [memoryCall([NOTE]), textTurn('done')], agent: { memory: { scope: 'session' } } });
    const result = await session.agent.task({ task: 't' });
    expect((await storedMemories(session.store)).map(({ scopeKey }) => scopeKey)).toEqual([`session:${result.runId}`]);
  });

  it(`turns ${PARALLEL_RUNS} parallel runs saving overlapping notes into exactly the deduplicated set`, async () => {
    const store = createInMemoryStore();
    const provider = createRespondingProvider(request => {
      if (hasToolResult(request)) return answerEvents('done');
      const [, runNumber] = /run number (\d+)/.exec(requestText(request)) ?? [];
      const shared = { kind: 'fact', text: `shared note ${Number(runNumber) % SHARED_NOTES}`, tags: null, pinned: null };
      const own = { kind: 'lesson', text: `own note ${runNumber}`, tags: null, pinned: null };
      return callEvents([{ id: 'c1', name: 'lookup', args: { key: `k${runNumber}`, memory: [shared, own] } }]);
    });
    const ai = createAigent({ providers: [provider], store, enableFeedback: false, memory: { scope: 'agent' } });
    const tools = [lookupTool([])];
    const uncapped = ai.agent({ name: 'helper', model: 'fake:m', tools });
    const capped = ai.agent({ name: 'capped', model: 'fake:m', tools, memory: { scope: 'agent', maxEntries: CAP } });
    const runAll = (agent: typeof uncapped) => Promise.all(Array.from({ length: PARALLEL_RUNS }, (_unused, runNumber) => agent.task({ task: `run number ${runNumber}` })));
    const [results, cappedResults] = await Promise.all([runAll(uncapped), runAll(capped)]);
    expect([...results, ...cappedResults].every(({ status }) => status === 'completed')).toBe(true);
    const entries = await storedMemories(store);
    const own = entries.filter(({ agentName }) => agentName === 'helper');
    // 25 shared notes, each sent by two runs: 0.6, then 0.7 for the repeat; a lost or duplicated write would show.
    expect(own.filter(({ kind }) => kind === 'fact').map(({ text, confidence }) => `${text}:${confidence}`).sort())
      .toEqual(Array.from({ length: SHARED_NOTES }, (_unused, note) => `shared note ${note}:0.7`).sort());
    expect(own.filter(({ kind }) => kind === 'lesson')).toHaveLength(PARALLEL_RUNS);
    const records = await Promise.all(results.map(async ({ runId }) => (await store.get<RunRecord>('runs', runId))?.value));
    expect(records.reduce((total, record) => total + (record?.memorySaved ?? 0), 0)).toBe(PARALLEL_RUNS * 2);
    // The capped agent ran at the same time on the same store: it never holds more than its cap, and nothing leaks across agents.
    expect(entries.filter(({ agentName }) => agentName === 'capped')).toHaveLength(CAP);
    expect(entries).toHaveLength(SHARED_NOTES + PARALLEL_RUNS + CAP);
  });
});
