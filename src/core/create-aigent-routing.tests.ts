import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { RunRecord } from '../telemetry/run-record.js';
import { createFakeProvider, textTurn } from '../testing/fake-provider.js';
import type { FakeProvider } from '../testing/fake-provider.js';
import { createAigentError } from './aigent-error.js';
import { createAigent } from './create-aigent.js';
import type { AigentOptions } from './aigent-types.js';
import type { IdGenerator } from './runtime-services.js';

function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

const ROUTES = { default: 'big:m', cheap: 'small:m', capable: 'huge:m' };
const unavailable = createAigentError({ code: 'provider_failed', message: 'HTTP 503 overloaded', details: { status: 503, retryable: true } });

function providers(turns: { big?: number; small?: number; huge?: number; backup?: number } = {}): Record<'big' | 'small' | 'huge' | 'backup', FakeProvider> {
  const make = (id: string, count = 0): FakeProvider => createFakeProvider({ id, turns: Array.from({ length: count }, (_, index) => textTurn(`${id} answer ${index + 1}`)) });
  return { big: make('big', turns.big), small: make('small', turns.small), huge: make('huge', turns.huge), backup: make('backup', turns.backup) };
}

function setup(params: { turns?: Parameters<typeof providers>[0]; options?: Partial<AigentOptions> }) {
  const fakes = providers(params.turns);
  const store = createInMemoryStore();
  const ai = createAigent({ providers: Object.values(fakes), store, ids: sequentialIds(), enableFeedback: false, sleep: async () => undefined, ...params.options });
  return { ai, fakes, store };
}

async function storedRun(params: { store: ReturnType<typeof createInMemoryStore>; runId: string }): Promise<RunRecord> {
  return (await params.store.get<RunRecord>('runs', params.runId))!.value;
}

describe('createAigent model routing', () => {
  it('runs a routed agent on its default model and records the decision', async () => {
    const { ai, fakes, store } = setup({ turns: { big: 1 } });
    const result = await ai.agent({ name: 'helper', model: ROUTES }).task({ task: 'find the readme' });
    expect(result.answer).toBe('big answer 1');
    expect(fakes.big.requests).toHaveLength(1);
    const run = await storedRun({ store, runId: result.runId });
    expect(run.model).toBe('big:m');
    expect(run.route).toMatchObject({ model: 'big:m', reason: 'default', evidence: { bucket: 'short:search' } });
    await ai.close();
  });

  it('sends quality tasks to the capable model', async () => {
    const { ai, fakes, store } = setup({ turns: { huge: 1 } });
    const result = await ai.agent({ name: 'helper', model: ROUTES }).task({ task: 'x', routingPriority: 'quality' });
    expect(result.answer).toBe('huge answer 1');
    expect(fakes.huge.requests[0]?.model).toBe('m');
    expect((await storedRun({ store, runId: result.runId })).route?.reason).toBe('priority-quality');
    await ai.close();
  });

  it('falls back from the chosen model to default, then to the route fallbacks', async () => {
    const fakes = providers({ backup: 1 });
    const hugeFails = createFakeProvider({ id: 'huge', turns: [{ events: [], failBeforeEvents: unavailable }] });
    const bigFails = createFakeProvider({ id: 'big', turns: [{ events: [], failBeforeEvents: unavailable }] });
    const ai = createAigent({ providers: [hugeFails, bigFails, fakes.small, fakes.backup], ids: sequentialIds(), enableFeedback: false, sleep: async () => undefined });
    const run = ai.agent({ name: 'helper', model: { ...ROUTES, fallback: ['backup:m'] }, resilience: { maxRetries: 0 } }).task({ task: 'x', routingPriority: 'quality' });
    const events = [];
    for await (const event of run) if (event.type === 'fallback') events.push(event);
    expect(await run).toMatchObject({ answer: 'backup answer 1', usage: { fallbacks: 2 } });
    expect(events).toEqual([
      { type: 'fallback', from: 'huge:m', to: 'big:m', reason: 'HTTP 503 overloaded' },
      { type: 'fallback', from: 'big:m', to: 'backup:m', reason: 'HTTP 503 overloaded' },
    ]);
    await ai.close();
  });

  it('learns from the stored runs when learning.routing is on', async () => {
    // Twenty runs on each model in the bucket: the cheap model succeeded every time, the others never.
    const { ai, fakes, store } = setup({ turns: { small: 1 }, options: { learning: { routing: { minSamples: 2, maxExploration: 0 } } } });
    const seeded = (index: number, model: string, isSuccess: boolean): RunRecord => ({
      schemaVersion: 1, runId: `seed_${model}_${index}`, responseId: `r_${model}_${index}`, agentName: 'helper', instanceId: 'i', mode: 'task', agentVersion: 'v', recordedAt: index,
      model, settings: {}, unattended: false, status: isSuccess ? 'completed' : 'failed',
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, turns: 1, toolCalls: 0, toolCallsPerTurn: 0, retries: 0, fallbacks: 0, durationMs: 1 },
      timings: { startedAt: index, durationMs: 1, modelMs: 1, toolMs: 0, queuedMs: 0 }, stepCount: 0, failureCount: 0, outcomeSummary: { claimedSuccess: 0, claimedFailure: 0 },
      toolUse: { calls: 0, items: 0, repeats: 0 }, route: { model, reason: 'default', evidence: { bucket: 'short:search', minSamples: 2 }, alternatives: [] },
    });
    for (let index = 0; index < 20; index += 1) {
      for (const [model, isSuccess] of [['small:m', true], ['big:m', false], ['huge:m', false]] as const) {
        const record = seeded(index, model, isSuccess);
        await store.compareAndSet({ collection: 'runs', key: record.runId, expectedVersion: undefined, value: record });
      }
    }
    const result = await ai.agent({ name: 'helper', model: ROUTES }).task({ task: 'find the readme' });
    expect(result.answer).toBe('small answer 1');
    expect(fakes.big.requests).toHaveLength(0);
    expect((await storedRun({ store, runId: result.runId })).route).toMatchObject({ model: 'small:m', reason: 'learned' });
    await ai.close();
  });

  it('validates routes and gives them a part in agentVersion', () => {
    const { ai } = setup({});
    expect(() => ai.agent({ name: 'a', model: { default: 'big:m', cheap: 'ghost:m' } })).toThrow(expect.objectContaining({ code: 'unknown_provider' }));
    expect(() => ai.agent({ name: 'a', model: { cheap: 'big:m' } as never })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
    const single = ai.agent({ name: 'a', model: 'big:m' }).agentVersion;
    expect(ai.agent({ name: 'a', model: { default: 'big:m' } }).agentVersion).not.toBe(single);
    expect(ai.agent({ name: 'a', model: ROUTES }).agentVersion).not.toBe(ai.agent({ name: 'a', model: { ...ROUTES, cheap: 'backup:m' } }).agentVersion);
  });

  it('rejects invalid learning options at createAigent', () => {
    expect(() => createAigent({ learning: { routing: { maxExploration: 2 } } })).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => createAigent({ learning: { responseCache: { ttlMs: 0 } } })).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });
});
