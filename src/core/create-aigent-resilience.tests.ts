import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider, textTurn } from '../testing/fake-provider.js';
import type { FakeProvider, FakeTurn } from '../testing/fake-provider.js';
import { createAigentError } from './aigent-error.js';
import type { AigentError } from './aigent-error.js';
import { createAigent } from './create-aigent.js';
import type { AigentOptions } from './aigent-types.js';
import type { AigentEvent } from './aigent-events.js';
import type { Clock, IdGenerator } from './runtime-services.js';

const clock: Clock = { now: () => 1_000 };

function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function failing(error: AigentError): FakeTurn {
  return { events: [], failBeforeEvents: error };
}

const unavailable = createAigentError({ code: 'provider_failed', message: 'HTTP 503 overloaded', details: { status: 503, retryable: true } });
const unauthorised = createAigentError({ code: 'provider_failed', message: 'HTTP 401 bad key', details: { status: 401, retryable: false } });

interface SetupParams {
  providers: FakeProvider[];
  options?: Partial<AigentOptions>;
}

function setup(params: SetupParams) {
  const { providers, options } = params;
  const delays: number[] = [];
  const ai = createAigent({
    providers, clock, ids: sequentialIds(),
    sleep: async ms => { delays.push(ms); },
    random: () => 0.5,
    ...options,
  });
  return { ai, delays };
}

describe('provider resilience through createAigent', () => {
  it('retries a retryable failure with backoff, emits retry events and counts them', async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider({ turns: [failing(unavailable), failing(unavailable), textTurn('ok')] });
    const { ai, delays } = setup({ providers: [provider], options: { store } });
    const run = ai.agent({ name: 'helper', model: 'fake:m' }).task({ task: 'x' });
    const events = await collect(run);
    const result = await run;
    expect(result).toMatchObject({ status: 'completed', answer: 'ok', usage: { turns: 1, retries: 2, fallbacks: 0, inputTokens: 10 } });
    expect(events.filter(event => event.type === 'retry')).toEqual([
      { type: 'retry', attempt: 1, delayMs: 500, model: 'fake:m', reason: 'HTTP 503 overloaded' },
      { type: 'retry', attempt: 2, delayMs: 1_000, model: 'fake:m', reason: 'HTTP 503 overloaded' },
    ]);
    expect(delays).toEqual([500, 1_000]);
    const record = await store.get<{ usage: { retries: number; fallbacks: number } }>('runs', result.runId);
    expect(record?.value.usage).toMatchObject({ retries: 2, fallbacks: 0 });
  });

  it('falls back to the next model once retries are exhausted and warns about its unsupported settings then', async () => {
    const primary = createFakeProvider({ turns: [failing(unavailable), failing(unavailable)] });
    const fakeBackup = createFakeProvider({ id: 'backup', turns: [textTurn('from backup')] });
    const backup: FakeProvider = { ...fakeBackup, capabilities: { ...fakeBackup.capabilities, supportedSettings: ['temperature'] } };
    const { ai } = setup({ providers: [primary, backup] });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', fallbackModels: ['backup:b'], resilience: { maxRetries: 1 }, modelSettings: { temperature: 0.2, seed: 1 } });
    const run = agent.task({ task: 'x' });
    const events = await collect(run);
    expect(await run).toMatchObject({ status: 'completed', answer: 'from backup', usage: { retries: 1, fallbacks: 1 } });
    const notable = events.filter(event => ['retry', 'fallback', 'warning'].includes(event.type));
    expect(notable).toEqual([
      { type: 'retry', attempt: 1, delayMs: 500, model: 'fake:m', reason: 'HTTP 503 overloaded' },
      { type: 'fallback', from: 'fake:m', to: 'backup:b', reason: 'HTTP 503 overloaded' },
      { type: 'warning', message: "Provider 'backup' does not support setting 'seed'; ignored" },
    ]);
    expect(fakeBackup.requests[0]).toMatchObject({ model: 'b', settings: { temperature: 0.2 } });
    expect(primary.requests[0]?.settings).toEqual({ temperature: 0.2, seed: 1 });
  });

  it('fails without retry or fallback on a non-retryable error by default', async () => {
    const primary = createFakeProvider({ turns: [failing(unauthorised)] });
    const backup = createFakeProvider({ id: 'backup', turns: [textTurn('unused')] });
    const { ai, delays } = setup({ providers: [primary, backup] });
    const run = ai.agent({ name: 'helper', model: 'fake:m', fallbackModels: ['backup:b'] }).task({ task: 'x' });
    const events = await collect(run);
    expect(await run).toMatchObject({ status: 'failed', failure: 'HTTP 401 bad key', usage: { retries: 0, fallbacks: 0 } });
    expect(events.some(event => event.type === 'retry' || event.type === 'fallback')).toBe(false);
    expect(backup.requests).toHaveLength(0);
    expect(delays).toEqual([]);
  });

  it('applies the agent firstEventTimeoutMs and retries a silent stream', async () => {
    const provider = createFakeProvider({ turns: [textTurn('late', { delayMs: 60_000 }), textTurn('quick')] });
    const { ai } = setup({ providers: [provider], options: { sleep: (ms, signal) => new Promise(resolve => {
      // Real timers here: the timeout must fire while the slow turn is still waiting.
      const timer = setTimeout(resolve, Math.min(ms, 20));
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    }) } });
    const run = ai.agent({ name: 'helper', model: 'fake:m', resilience: { firstEventTimeoutMs: 1_000 } }).task({ task: 'x' });
    const events = await collect(run);
    expect(await run).toMatchObject({ status: 'completed', answer: 'quick', usage: { retries: 1 } });
    expect(events).toContainEqual(expect.objectContaining({ type: 'retry', reason: expect.stringContaining('no event within 1000 ms') }));
  });

  it('settles as cancelled when cancelled during a backoff sleep', async () => {
    const provider = createFakeProvider({ turns: [failing(unavailable), textTurn('never')] });
    let sleeping: () => void = () => undefined;
    const isSleeping = new Promise<void>(resolve => { sleeping = resolve; });
    const { ai } = setup({ providers: [provider], options: { sleep: (_ms, signal) => new Promise(resolve => { sleeping(); signal.addEventListener('abort', () => resolve(), { once: true }); }) } });
    const run = ai.agent({ name: 'helper', model: 'fake:m' }).task({ task: 'x' });
    await isSleeping;
    run.cancel();
    expect(await run).toMatchObject({ status: 'cancelled', usage: { retries: 1 } });
    expect(provider.requests).toHaveLength(1);
  });

  it('rejects invalid fallback models and resilience policies at agent creation', () => {
    const { ai } = setup({ providers: [createFakeProvider({ turns: [] })] });
    expect(() => ai.agent({ name: 'a', model: 'fake:m', fallbackModels: ['nope'] })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
    expect(() => ai.agent({ name: 'a', model: 'fake:m', fallbackModels: ['ghost:m'] })).toThrow(expect.objectContaining({ code: 'unknown_provider' }));
    expect(() => ai.agent({ name: 'a', model: 'fake:m', resilience: { jitter: 2 } })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringContaining('jitter') }));
  });

  it('gives fallback models and resilience a part in agentVersion', () => {
    const { ai } = setup({ providers: [createFakeProvider({ turns: [] }), createFakeProvider({ id: 'backup', turns: [] })] });
    const plain = ai.agent({ name: 'a', model: 'fake:m' }).agentVersion;
    expect(ai.agent({ name: 'a', model: 'fake:m', fallbackModels: ['backup:b'] }).agentVersion).not.toBe(plain);
    expect(ai.agent({ name: 'a', model: 'fake:m', resilience: { maxRetries: 0 } }).agentVersion).not.toBe(plain);
  });
});
