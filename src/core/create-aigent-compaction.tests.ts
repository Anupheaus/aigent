import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { estimatePromptTokens } from '../context/estimate-prompt-tokens.js';
import { computePrefixHash } from '../context/prefix-hash.js';
import { SUMMARISER_PROMPT, SUMMARY_HEADING } from '../context/summarise.js';
import type { ProviderRequest, Usage } from '../providers/provider-types.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { defineTool } from '../tools/define-tool.js';
import type { AgentDefinition } from './agent-types.js';
import type { AigentEvent } from './aigent-events.js';
import { createAigent } from './create-aigent.js';

/** No reported input tokens, so the estimate is never recalibrated and the arithmetic stays predictable. */
const NO_INPUT: Usage = { inputTokens: 0, outputTokens: 1, cachedTokens: 0 };
const SUMMARY_USAGE: Usage = { inputTokens: 300, outputTokens: 40, cachedTokens: 0 };
const CONTEXT_SIZE = 12_000;
/** 12,000 less the default reserve (a quarter of the window, as maxOutputTokens is unset). */
const USABLE_BUDGET = 9_000;
const RESULT_CHARS = 2_000;
const ROUNDS = 30;

const fetchTool = defineTool({
  name: 'fetch', description: 'Fetch a page', args: z.object({ n: z.number() }).strict(), deterministic: false, cache: false,
  describeActivity: () => ({ title: 'fetch' }), run: async ({ n }) => `page ${n}: `.padEnd(RESULT_CHARS, 'x'),
});

function fetchTurns(count: number): FakeTurn[] {
  return Array.from({ length: count }, (_unused, round) => toolTurn([{ id: `f${round}`, name: 'fetch', args: { n: round } }], { usage: NO_INPUT }));
}

function summaryTurns(count: number): FakeTurn[] {
  return Array.from({ length: count }, (_unused, index) => textTurn(`Goal: fetch pages\nFacts: summary ${index + 1}`, { usage: SUMMARY_USAGE }));
}

interface SetupParams {
  turns: FakeTurn[];
  summaries?: FakeTurn[];
  definition?: Partial<AgentDefinition>;
}

function setup(params: SetupParams) {
  const { turns, summaries = summaryTurns(20), definition = {} } = params;
  const provider = createFakeProvider({ turns });
  const summariser = createFakeProvider({ id: 'sum', turns: summaries });
  const ai = createAigent({ providers: [provider, summariser], enableFeedback: false });
  const agent = ai.agent({
    name: 'compactor', model: 'fake:m', tools: [fetchTool], compactionModel: 'sum:s', limits: { maxTurns: 40 }, todo: false,
    modelSettings: { contextSize: CONTEXT_SIZE }, ...definition,
  });
  return { provider, summariser, agent, ai };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function stablePart(request: ProviderRequest): ProviderRequest['messages'] {
  return request.messages.filter(({ volatile }) => volatile !== true);
}

describe('createAigent compaction', () => {
  it('completes a 30-turn task inside a small window with several compactions, append-only between them', async () => {
    const { provider, summariser, agent } = setup({ turns: [...fetchTurns(ROUNDS), textTurn('final answer', { usage: NO_INPUT })] });
    const run = agent.task({ task: 'Fetch every page and report' });
    const events = await collect(run);
    const result = await run;
    expect(result).toMatchObject({ status: 'completed', answer: 'final answer' });
    const compactions = result.usage.compactions ?? 0;
    expect(compactions).toBeGreaterThanOrEqual(2);
    expect(events.filter(event => event.type === 'compaction').length).toBeGreaterThanOrEqual(compactions);
    // Never an oversized request.
    for (const request of provider.requests) expect(estimatePromptTokens(request)).toBeLessThanOrEqual(USABLE_BUDGET);
    // The prefix breaks exactly once per compaction; every other turn only appends.
    const breaks = provider.requests.slice(1).filter((request, index) => {
      const previous = stablePart(provider.requests[index]!);
      return computePrefixHash(stablePart(request).slice(0, previous.length), request.tools) !== computePrefixHash(previous, provider.requests[index]!.tools);
    });
    expect(breaks).toHaveLength(compactions);
    // System prompt and brief survive every compaction byte-identical, at the front.
    const [first] = provider.requests;
    for (const request of provider.requests) expect(request.messages.slice(0, 2)).toEqual(first!.messages.slice(0, 2));
    // Summaries (if stubbing was not enough) are counted.
    expect(result.usage.compactionTokens).toBe(summariser.requests.length * (SUMMARY_USAGE.inputTokens + SUMMARY_USAGE.outputTokens));
    expect(result.usage.compactionTokensSaved).toBeGreaterThan(0);
    expect(events.filter(event => event.type === 'warning')).toEqual([]);
  });

  it('keeps one summary after the hoist, with a cache breakpoint on it, and merges the previous summary', async () => {
    // Long enough for two summaries: each compaction now lands far below compactAt.
    const rounds = 3 * ROUNDS;
    const { provider, summariser, agent } = setup({ turns: [...fetchTurns(rounds), textTurn('done', { usage: NO_INPUT })], definition: { compaction: { compactTo: 0.2, keepRecent: 2 }, limits: { maxTurns: rounds + 1 } } });
    await agent.task({ task: 'Fetch' });
    const last = provider.requests.at(-1)!;
    const summaries = last.messages.flatMap(({ text }, index) => (text?.startsWith(SUMMARY_HEADING) === true ? [index] : []));
    expect(summaries).toHaveLength(1);
    expect(last.cacheBreakpoints).toContain(summaries[0]);
    expect(summariser.requests.length).toBeGreaterThanOrEqual(2);
    expect(summariser.requests[0]?.messages[0]).toEqual({ role: 'system', text: SUMMARISER_PROMPT });
    expect(summariser.requests[1]?.messages[1]?.text).toContain('## Previous summary');
  });

  it('keeps rounds with a non-compactable result in chronological order and still stubs their big compactable results', async () => {
    const keepTool = defineTool({
      name: 'keep', description: 'Keep a note', args: z.object({ n: z.number() }).strict(), deterministic: false, cache: false, compactable: false,
      describeActivity: () => ({ title: 'keep' }), run: async ({ n }) => `note ${n}`,
    });
    const mixedTurns = Array.from({ length: ROUNDS }, (_unused, round) => toolTurn([{ id: `f${round}`, name: 'fetch', args: { n: round } }, { id: `k${round}`, name: 'keep', args: { n: round } }], { usage: NO_INPUT }));
    const { provider, agent } = setup({ turns: [...mixedTurns, textTurn('done', { usage: NO_INPUT })], definition: { tools: [fetchTool, keepTool] } });
    const result = await agent.task({ task: 'Fetch and keep' });
    expect(result.status).toBe('completed');
    const last = provider.requests.at(-1)!;
    const callOrder = last.messages.flatMap(({ toolCalls = [] }) => toolCalls.map(({ id }) => Number(id.slice(1))));
    expect(callOrder).toEqual([...callOrder].sort((left, right) => left - right));
    // The newest round is last, after the summary, not hoisted ahead of older rounds.
    expect(last.messages.filter(({ volatile }) => volatile !== true).at(-1)?.toolCallId).toBe(`k${ROUNDS - 1}`);
    // Old fetch results riding in kept rounds were stubbed, so the kept block stays small.
    expect(last.messages.find(({ toolCallId }) => toolCallId === 'f0')?.text ?? '').not.toContain('page 0: ');
  });

  it('never compacts mid tool round: every compaction comes after all results of the round before it', async () => {
    const { agent } = setup({ turns: [...fetchTurns(ROUNDS), textTurn('done', { usage: NO_INPUT })] });
    const events = await collect(agent.task({ task: 'Fetch' }));
    const open = new Set<string>();
    let compactions = 0;
    for (const event of events) {
      if (event.type === 'tool-call') open.add(event.callId);
      if (event.type === 'tool-result') open.delete(event.callId);
      if (event.type === 'compaction') { compactions += 1; expect([...open]).toEqual([]); }
    }
    expect(compactions).toBeGreaterThan(0);
  });

  it('falls back to stubbing with a warning when the summariser fails', async () => {
    const { agent } = setup({ turns: [...fetchTurns(ROUNDS), textTurn('done', { usage: NO_INPUT })], summaries: [], definition: { compaction: { compactTo: 0.2 } } });
    const run = agent.task({ task: 'Fetch' });
    const events = await collect(run);
    expect(events).toContainEqual({ type: 'warning', message: expect.stringContaining('Compaction summary failed') });
    expect((await run).status).toBe('completed');
  });

  it('returns the original of a stubbed result through result_original, registered at the first compaction', async () => {
    const { provider, agent } = setup({ turns: [...fetchTurns(ROUNDS), toolTurn([{ id: 'orig', name: 'result_original', args: { handles: ['H1'] } }], { usage: NO_INPUT }), textTurn('done', { usage: NO_INPUT })] });
    const run = agent.task({ task: 'Fetch' });
    const events = await collect(run);
    expect(provider.requests[0]?.tools.map(({ name }) => name)).not.toContain('result_original');
    expect(provider.requests.at(-1)?.tools.map(({ name }) => name)).toContain('result_original');
    const fetched = events.find(event => event.type === 'tool-result' && event.callId === 'orig');
    // The original is exactly the tool message the model saw before the stub replaced it.
    const seen = provider.requests[1]?.messages.find(({ toolCallId }) => toolCallId === 'f0')?.text;
    expect(seen).toContain('page 0: ');
    expect(fetched).toMatchObject({ envelope: { ok: true, result: [{ index: 0, ok: true, result: { handle: 'H1', text: seen } }] } });
  });

  it('fails clearly when the non-compactable context alone is too large, before any request', async () => {
    const { provider, agent } = setup({ turns: [textTurn('never')], definition: { modelSettings: { contextSize: 4_000 } } });
    const result = await agent.task({ task: 'x'.repeat(20_000) });
    expect(result).toMatchObject({ status: 'failed', failure: expect.stringContaining('Non-compactable context too large') });
    expect(provider.requests).toEqual([]);
  });

  it('stores the compaction figures on the run record', async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider({ turns: [...fetchTurns(ROUNDS), textTurn('done', { usage: NO_INPUT })] });
    const ai = createAigent({ providers: [provider], store, enableFeedback: false });
    const agent = ai.agent({ name: 'stored', model: 'fake:m', tools: [fetchTool], todo: false, limits: { maxTurns: 40 }, modelSettings: { contextSize: CONTEXT_SIZE } });
    const result = await agent.task({ task: 'Fetch' });
    await ai.close();
    const trace = await ai.trace(result.runId);
    expect(trace?.run.usage).toMatchObject({ compactions: result.usage.compactions, compactionTokensSaved: result.usage.compactionTokensSaved, contextTokensPeak: result.usage.contextTokensPeak });
    expect(result.usage.compactions).toBeGreaterThan(0);
  });

  it('validates the policy and the compaction model at ai.agent, and hashes them into the version', () => {
    const { ai } = setup({ turns: [] });
    const base = { name: 'v', model: 'fake:m' };
    expect(() => ai.agent({ ...base, compaction: { compactAt: 0.4 } })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
    expect(() => ai.agent({ ...base, compactionModel: 'nope:m' })).toThrow(expect.objectContaining({ code: 'unknown_provider' }));
    const plain = ai.agent(base).agentVersion;
    expect(ai.agent({ ...base, compaction: { keepRecent: 6 } }).agentVersion).not.toBe(plain);
    expect(ai.agent({ ...base, compactionModel: 'sum:s' }).agentVersion).not.toBe(plain);
  });
});
