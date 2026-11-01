import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeProvider, FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import { createAigentError } from './aigent-error.js';
import type { AigentEvent } from './aigent-events.js';
import type { AgentDefinition } from './agent-types.js';
import { createAigent } from './create-aigent.js';
import type { ResponseCacheOptions } from '../cache/response-cache.js';
import type { IdGenerator } from './runtime-services.js';

function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

const TTL_MS = 60_000;

function readTool(params: { cache: boolean }): Tool {
  return defineTool({
    name: 'read', description: 'Read a file', args: z.object({ path: z.string() }).strict(), deterministic: params.cache, cache: params.cache,
    describeActivity: ({ path }) => ({ title: `Reading ${path}` }), run: async ({ path }) => ({ text: `contents of ${path}` }),
  });
}

const writeTool = defineTool({
  name: 'write', description: 'Write a file', args: z.object({ path: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true,
  describeActivity: ({ path }) => ({ title: `Writing ${path}` }), run: async () => ({ written: true }),
});

function setup(params: { turns: FakeTurn[]; responseCache?: Partial<ResponseCacheOptions> }) {
  let now = 1_000;
  const provider = createFakeProvider({ turns: params.turns });
  const ai = createAigent({
    providers: [provider], ids: sequentialIds(), enableFeedback: false, clock: { now: () => now },
    learning: { responseCache: { ttlMs: TTL_MS, ...params.responseCache } },
  });
  return { ai, provider, advance: (ms: number) => { now += ms; } };
}

const reproducible: Partial<AgentDefinition> = { modelSettings: { temperature: 0 } };

async function usageEvents(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) if (event.type === 'usage') events.push(event);
  return events;
}

function requestsOf(provider: FakeProvider): number {
  return provider.requests.length;
}

describe('createAigent response cache', () => {
  it('replays an identical temperature-0 request at zero cost, marked cachedResponse', async () => {
    const { ai, provider } = setup({ turns: [textTurn('the answer')] });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', ...reproducible });
    const first = await agent.task({ task: 'what is it?' });
    const secondRun = agent.task({ task: 'what is it?' });
    const usage = await usageEvents(secondRun);
    const second = await secondRun;
    expect(requestsOf(provider)).toBe(1);
    expect(second.answer).toBe(first.answer);
    expect(second.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, cachedResponses: 1 });
    expect(first.usage.cachedResponses).toBeUndefined();
    expect(usage).toEqual([{ type: 'usage', usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, cachedResponse: true }]);
    await ai.close();
  });

  it('replays a seeded request, but never one sampled without temperature 0 or a seed', async () => {
    const seeded = setup({ turns: [textTurn('a')] });
    const seededAgent = seeded.ai.agent({ name: 'helper', model: 'fake:m', modelSettings: { temperature: 0.7, seed: 3 } });
    await seededAgent.task({ task: 'q' });
    await seededAgent.task({ task: 'q' });
    expect(requestsOf(seeded.provider)).toBe(1);
    const sampled = setup({ turns: [textTurn('a'), textTurn('b')] });
    const sampledAgent = sampled.ai.agent({ name: 'helper', model: 'fake:m', modelSettings: { temperature: 0.7 } });
    await sampledAgent.task({ task: 'q' });
    expect((await sampledAgent.task({ task: 'q' })).answer).toBe('b');
    expect(requestsOf(sampled.provider)).toBe(2);
  });

  it('replays responses whose calls are all deterministic and cached (the calls run again)', async () => {
    const call = toolTurn([{ id: 'c1', name: 'read', args: { path: 'a' } }]);
    const { ai, provider } = setup({ turns: [call, textTurn('done')] });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', tools: [readTool({ cache: true })], ...reproducible });
    await agent.task({ task: 'read a' });
    const second = await agent.task({ task: 'read a' });
    expect(requestsOf(provider)).toBe(2);
    expect(second).toMatchObject({ answer: 'done', usage: { cachedResponses: 2, toolCalls: 1 } });
  });

  it('never stores a response that calls a tool that is not cached', async () => {
    const call = toolTurn([{ id: 'c1', name: 'read', args: { path: 'a' } }]);
    const { ai, provider } = setup({ turns: [call, textTurn('done'), call, textTurn('done')] });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', tools: [readTool({ cache: false })], ...reproducible });
    await agent.task({ task: 'read a' });
    const second = await agent.task({ task: 'read a' });
    // The final text answer follows a read round without side effects, so it alone is replayed.
    expect(requestsOf(provider)).toBe(3);
    expect(second.usage.cachedResponses).toBe(1);
  });

  it('neither replays nor stores the turn after a round with side effects', async () => {
    const call = toolTurn([{ id: 'c1', name: 'write', args: { path: 'a' } }]);
    const { ai, provider } = setup({ turns: [call, textTurn('written'), call, textTurn('written again')] });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', tools: [writeTool], ...reproducible });
    await agent.task({ task: 'write a' });
    const second = await agent.task({ task: 'write a' });
    expect(requestsOf(provider)).toBe(4);
    expect(second).toMatchObject({ answer: 'written again' });
    expect(second.usage.cachedResponses).toBeUndefined();
  });

  it('misses when the settings change', async () => {
    const { ai, provider } = setup({ turns: [textTurn('a'), textTurn('b')] });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', ...reproducible });
    await agent.task({ task: 'q' });
    expect((await agent.task({ task: 'q', modelSettings: { maxOutputTokens: 100 } })).answer).toBe('b');
    expect(requestsOf(provider)).toBe(2);
  });

  it('is per agent instance unless shared, and never shared across agent versions', async () => {
    const perInstance = setup({ turns: [textTurn('a'), textTurn('b')] });
    await perInstance.ai.agent({ name: 'helper', model: 'fake:m', ...reproducible }).task({ task: 'q' });
    expect((await perInstance.ai.agent({ name: 'helper', model: 'fake:m', ...reproducible }).task({ task: 'q' })).answer).toBe('b');
    const shared = setup({ turns: [textTurn('a'), textTurn('b')], responseCache: { shared: true } });
    await shared.ai.agent({ name: 'helper', model: 'fake:m', ...reproducible }).task({ task: 'q' });
    expect((await shared.ai.agent({ name: 'helper', model: 'fake:m', ...reproducible }).task({ task: 'q' })).answer).toBe('a');
    // Same prompt, same settings, but another version label: a different agent version.
    expect((await shared.ai.agent({ name: 'helper', model: 'fake:m', version: '2', ...reproducible }).task({ task: 'q' })).answer).toBe('b');
    expect(requestsOf(shared.provider)).toBe(2);
  });

  it('honours the TTL', async () => {
    const { ai, provider, advance } = setup({ turns: [textTurn('a'), textTurn('b')] });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', ...reproducible });
    await agent.task({ task: 'q' });
    advance(TTL_MS);
    expect((await agent.task({ task: 'q' })).answer).toBe('b');
    expect(requestsOf(provider)).toBe(2);
  });

  it('never caches a failed request', async () => {
    const rejected = createAigentError({ code: 'provider_failed', message: 'HTTP 401 bad key', details: { status: 401, retryable: false } });
    const { ai, provider } = setup({ turns: [{ events: [], failBeforeEvents: rejected }, textTurn('ok')] });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', ...reproducible });
    expect((await agent.task({ task: 'q' })).status).toBe('failed');
    expect((await agent.task({ task: 'q' })).answer).toBe('ok');
    expect(requestsOf(provider)).toBe(2);
  });

  it('can be inspected and cleared through ai.learning', async () => {
    const { ai, provider } = setup({ turns: [textTurn('a'), textTurn('b')] });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', ...reproducible });
    await agent.task({ task: 'q' });
    expect(ai.learning.responseCache.size()).toBe(1);
    ai.learning.responseCache.clear();
    expect((await agent.task({ task: 'q' })).answer).toBe('b');
    expect(requestsOf(provider)).toBe(2);
  });
});
