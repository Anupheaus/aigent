import { describe, expect, it } from 'vitest';
import type { ProviderEvent } from '../providers/provider-types.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider, textTurn } from '../testing/fake-provider.js';
import type { FakeProvider, FakeTurn } from '../testing/fake-provider.js';
import { createAigentError } from './aigent-error.js';
import { createAigent } from './create-aigent.js';
import type { AigentOptions } from './aigent-types.js';
import type { AigentEvent } from './aigent-events.js';
import type { Clock, IdGenerator } from './runtime-services.js';

const clock: Clock = { now: () => 1_000 };
const HEX_SHA_256 = /^[0-9a-f]{64}$/;

function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function aigentWith(params: { provider: FakeProvider; options?: Partial<AigentOptions> }) {
  const { provider, options } = params;
  return createAigent({ providers: [provider], clock, ids: sequentialIds(), ...options });
}

function warnings(events: AigentEvent[]): string[] {
  return events.flatMap(event => (event.type === 'warning' ? [event.message] : []));
}

const thinkingTurn: FakeTurn = {
  events: [{ type: 'thinking-delta', text: 'hmm' }, { type: 'text-delta', text: 'ok' }, { type: 'done', finishReason: 'stop' }] satisfies ProviderEvent[],
};

describe('model settings through createAigent', () => {
  it('resolves settings task > agent > runtime > provider and sends them on every request', async () => {
    const provider = createFakeProvider({ turns: [textTurn('ok')] });
    const ai = aigentWith({ provider, options: {
      modelSettings: { temperature: 0.3, topP: 0.5, maxOutputTokens: 900 },
      providerModelSettings: { fake: { temperature: 0.4, topP: 0.6, maxOutputTokens: 800, seed: 9, stop: ['P'] } },
    } });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', modelSettings: { temperature: 0.2, topP: 0.7 } });
    await agent.task({ task: 'x', modelSettings: { temperature: 0.1 } });
    expect(provider.requests[0]?.settings).toEqual({ temperature: 0.1, topP: 0.7, maxOutputTokens: 900, seed: 9, stop: ['P'] });
  });

  it('sends each provider only its own providerOptions, also to fallbacks', async () => {
    const down = createAigentError({ code: 'provider_failed', message: 'down', details: { retryable: true } });
    const primary = createFakeProvider({ id: 'fake', turns: [1, 2, 3].map(() => ({ events: [], failBeforeEvents: down })) });
    const backup = createFakeProvider({ id: 'backup', turns: [textTurn('ok')] });
    const ai = createAigent({ providers: [primary, backup], clock, ids: sequentialIds(), sleep: async () => undefined, random: () => 0.5 });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', fallbackModels: ['backup:m'], modelSettings: { providerOptions: { fake: { top_k: 3 }, backup: { logprobs: true } } } });
    expect((await agent.task({ task: 'x' })).status).toBe('completed');
    expect(primary.requests[0]?.settings).toEqual({ providerOptions: { top_k: 3 } });
    expect(backup.requests[0]?.settings).toEqual({ providerOptions: { logprobs: true } });
  });

  it('sends no settings field when none are configured', async () => {
    const provider = createFakeProvider({ turns: [textTurn('ok')] });
    await aigentWith({ provider }).agent({ name: 'helper', model: 'fake:m' }).task({ task: 'x' });
    expect(provider.requests[0]).not.toHaveProperty('settings');
  });

  it('keeps runtime-only settings (contextSize, showThinking) out of the provider request', async () => {
    const provider = createFakeProvider({ turns: [textTurn('ok')] });
    await aigentWith({ provider }).agent({ name: 'helper', model: 'fake:m', modelSettings: { contextSize: 64_000, showThinking: true, seed: 1 } }).task({ task: 'x' });
    expect(provider.requests[0]?.settings).toEqual({ seed: 1 });
  });

  it('emits thinking deltas by default and hides them when showThinking is false', async () => {
    const shown = await collect(aigentWith({ provider: createFakeProvider({ turns: [thinkingTurn] }) }).agent({ name: 'a', model: 'fake:m' }).task({ task: 'x' }));
    expect(shown).toContainEqual({ type: 'thinking-delta', text: 'hmm' });
    const hiddenRun = aigentWith({ provider: createFakeProvider({ turns: [thinkingTurn] }) }).agent({ name: 'a', model: 'fake:m' }).task({ task: 'x', modelSettings: { showThinking: false } });
    const hidden = await collect(hiddenRun);
    expect(hidden.some(event => event.type === 'thinking-delta')).toBe(false);
    expect((await hiddenRun).answer).toBe('ok');
  });

  it('warns once per unsupported setting per run and never sends it', async () => {
    const fake = createFakeProvider({ turns: [textTurn('one'), textTurn('two')] });
    const provider: FakeProvider = { ...fake, capabilities: { ...fake.capabilities, supportedSettings: ['temperature'] } };
    const agent = aigentWith({ provider }).agent({ name: 'helper', model: 'fake:m', modelSettings: { temperature: 1, seed: 4, stop: ['x'] } });
    const events = await collect(agent.task({ task: 'x' }));
    expect(warnings(events)).toEqual([
      "Provider 'fake' does not support setting 'stop'; ignored",
      "Provider 'fake' does not support setting 'seed'; ignored",
    ]);
    expect(fake.requests[0]?.settings).toEqual({ temperature: 1 });
  });

  it('records agentVersion, model, resolved settings and version label on the run record', async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider({ turns: [textTurn('ok')] });
    const agent = aigentWith({ provider, options: { store, modelSettings: { maxOutputTokens: 500 } } })
      .agent({ name: 'helper', model: 'fake:m', version: 'v3', modelSettings: { contextSize: 10_000, temperature: 0.5 } });
    const result = await agent.task({ task: 'x', modelSettings: { temperature: 0.9 } });
    const record = await store.get<Record<string, unknown>>('runs', result.runId);
    expect(record?.value).toMatchObject({
      agentVersion: agent.agentVersion,
      model: 'fake:m',
      version: 'v3',
      settings: { temperature: 0.9, maxOutputTokens: 500 },
      runtimeSettings: { contextSize: 10_000 },
    });
    expect(record?.value).not.toHaveProperty('droppedSettings');
    expect(record?.value).not.toHaveProperty('fallbacks');
  });

  it('records only the settings the model was sent, naming the ones it dropped, and only its own providerOptions', async () => {
    const store = createInMemoryStore();
    const fake = createFakeProvider({ turns: [textTurn('ok')] });
    const provider: FakeProvider = { ...fake, capabilities: { ...fake.capabilities, supportedSettings: ['temperature', 'providerOptions'] } };
    const agent = aigentWith({ provider, options: { store } })
      .agent({ name: 'helper', model: 'fake:m', modelSettings: { temperature: 0.5, seed: 4, providerOptions: { fake: { top_k: 2 }, other: { secret_ref: 'x' } } } });
    const result = await agent.task({ task: 'x' });
    const record = await store.get<Record<string, unknown>>('runs', result.runId);
    expect(record?.value).toMatchObject({ settings: { temperature: 0.5, providerOptions: { top_k: 2 } }, droppedSettings: ['seed'] });
    expect(record?.value).not.toHaveProperty('runtimeSettings');
  });

  it('records what each fallback model the run used was sent, and only those', async () => {
    const store = createInMemoryStore();
    const down = createAigentError({ code: 'provider_failed', message: 'down', details: { retryable: true } });
    const primary = createFakeProvider({ id: 'fake', turns: [1, 2, 3].map(() => ({ events: [], failBeforeEvents: down })) });
    const fakeBackup = createFakeProvider({ id: 'backup', turns: [textTurn('ok')] });
    const backup: FakeProvider = { ...fakeBackup, capabilities: { ...fakeBackup.capabilities, supportedSettings: ['maxOutputTokens'] } };
    const unused = createFakeProvider({ id: 'unused', turns: [] });
    const ai = createAigent({ providers: [primary, backup, unused], clock, ids: sequentialIds(), store, sleep: async () => undefined, random: () => 0.5 });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', fallbackModels: ['backup:m', 'unused:m'], modelSettings: { maxOutputTokens: 100, temperature: 0.2 } });
    const result = await agent.task({ task: 'x' });
    const record = await store.get<Record<string, unknown>>('runs', result.runId);
    expect(record?.value).toMatchObject({ model: 'fake:m', settings: { maxOutputTokens: 100, temperature: 0.2 } });
    expect((record?.value as Record<string, unknown>).fallbacks).toEqual([{ model: 'backup:m', settings: { maxOutputTokens: 100 }, droppedSettings: ['temperature'] }]);
  });

  it('leaves the version label out of the run record when the agent has none', async () => {
    const store = createInMemoryStore();
    const result = await aigentWith({ provider: createFakeProvider({ turns: [textTurn('ok')] }), options: { store } }).agent({ name: 'h', model: 'fake:m' }).task({ task: 'x' });
    const record = await store.get<Record<string, unknown>>('runs', result.runId);
    expect(record?.value).toMatchObject({ settings: {} });
    expect(record?.value).not.toHaveProperty('version');
  });
});

describe('model settings validation', () => {
  it('rejects invalid agent settings when the agent is created', () => {
    const ai = aigentWith({ provider: createFakeProvider({ turns: [] }) });
    expect(() => ai.agent({ name: 'hot', model: 'fake:m', modelSettings: { temperature: 3 } })).toThrow(expect.objectContaining({
      code: 'invalid_definition', message: expect.stringMatching(/^Agent 'hot' has invalid modelSettings: temperature/),
    }));
  });

  it('rejects invalid task settings when the task is started', () => {
    const agent = aigentWith({ provider: createFakeProvider({ turns: [] }) }).agent({ name: 'a', model: 'fake:m' });
    expect(() => agent.task({ task: 'x', modelSettings: { stop: ['a', 'b', 'c', 'd', 'e'] } })).toThrow(expect.objectContaining({
      code: 'invalid_input', message: expect.stringContaining('modelSettings.stop'),
    }));
  });

  it('rejects invalid runtime and per-provider settings when the aigent is created', () => {
    const provider = createFakeProvider({ turns: [] });
    expect(() => aigentWith({ provider, options: { modelSettings: { topP: 2 } } })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringMatching(/^createAigent has invalid modelSettings: topP/) }));
    expect(() => aigentWith({ provider, options: { providerModelSettings: { fake: { seed: -2 } } } })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringMatching(/^Provider 'fake' has invalid modelSettings: seed/) }));
    expect(() => aigentWith({ provider, options: { providerModelSettings: { nope: {} } } })).toThrow(expect.objectContaining({ code: 'unknown_provider' }));
  });
});

describe('agentVersion', () => {
  it('is a sha-256 that ignores name and instanceId but follows the definition', () => {
    const ai = aigentWith({ provider: createFakeProvider({ turns: [] }) });
    const first = ai.agent({ name: 'a', model: 'fake:m', persona: 'Calm' });
    const renamed = ai.agent({ name: 'b', model: 'fake:m', persona: 'Calm', instanceId: 'fixed' });
    const changed = ai.agent({ name: 'a', model: 'fake:m', persona: 'Brisk' });
    expect(first.agentVersion).toMatch(HEX_SHA_256);
    expect(renamed.agentVersion).toBe(first.agentVersion);
    expect(changed.agentVersion).not.toBe(first.agentVersion);
  });

  it("follows a fallback provider's settings, and ignores empty or default-valued definition fields", () => {
    const fake = createFakeProvider({ turns: [] });
    const backup = createFakeProvider({ id: 'backup', turns: [] });
    const definition = { name: 'a', model: 'fake:m', fallbackModels: ['backup:m'] };
    const plain = createAigent({ providers: [fake, backup] }).agent(definition);
    const tuned = createAigent({ providers: [fake, backup], providerModelSettings: { backup: { temperature: 0.9 } } }).agent(definition);
    expect(tuned.agentVersion).not.toBe(plain.agentVersion);
    const ai = createAigent({ providers: [fake, backup] });
    const bare = ai.agent({ name: 'a', model: 'fake:m' });
    const noisy = ai.agent({ name: 'a', model: 'fake:m', resilience: { maxRetries: 2 }, fallbackModels: [], limits: {}, modelSettings: {} });
    expect(noisy.agentVersion).toBe(bare.agentVersion);
  });

  it('follows the effective agent-level settings, including runtime defaults', () => {
    const provider = createFakeProvider({ turns: [] });
    const plain = aigentWith({ provider }).agent({ name: 'a', model: 'fake:m' });
    const withRuntime = aigentWith({ provider, options: { modelSettings: { temperature: 0.1 } } }).agent({ name: 'a', model: 'fake:m' });
    expect(withRuntime.agentVersion).not.toBe(plain.agentVersion);
  });
});
