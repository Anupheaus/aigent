import { describe, expect, it } from 'vitest';
import type { ProviderEvent } from '../providers/provider-types.js';
import { createScheduler } from '../scheduler/scheduler.js';
import type { LeaseRequest, Scheduler } from '../scheduler/scheduler-types.js';
import { createFakeProvider, textTurn } from '../testing/fake-provider.js';
import type { FakeProvider } from '../testing/fake-provider.js';
import { createAigentError } from './aigent-error.js';
import type { AigentEvent } from './aigent-events.js';
import { openTurnStream } from './open-turn-stream.js';
import type { ProviderTarget, ResilienceCounters, TurnRequest, TurnRouting } from './open-turn-stream.js';
import { DEFAULT_RESILIENCE_POLICY } from './resilience-policy.js';

const REQUEST: TurnRequest = { messages: [{ role: 'user', text: 'hi' }], tools: [] };
const RETRYABLE = createAigentError({ code: 'provider_failed', message: 'HTTP 503', details: { retryable: true, status: 503 } });

function targetFor(params: { provider: FakeProvider; label: string; warnings?: string[]; settings?: ProviderTarget['settings'] }): ProviderTarget {
  const { provider, label, warnings = [], settings } = params;
  return { label, provider, model: 'm', warnings, dropped: [], ...(settings == null ? {} : { settings }) };
}

function routingFor(params: { targets: [ProviderTarget, ...ProviderTarget[]]; scheduler?: Scheduler; maxRetries?: number }): TurnRouting {
  const { targets, scheduler = createScheduler({}), maxRetries = DEFAULT_RESILIENCE_POLICY.maxRetries } = params;
  return {
    targets, scheduler,
    policy: { ...DEFAULT_RESILIENCE_POLICY, maxRetries, jitter: 0 },
    sleep: async () => undefined,
    random: () => 0.5,
    usedLabels: new Set([targets[0].label]),
    priority: 'background',
    agentName: 'helper',
  };
}

interface Opened {
  events: ProviderEvent[];
  emitted: AigentEvent[];
  counters: ResilienceCounters;
}

async function runTurnStream(routing: TurnRouting): Promise<Opened> {
  const emitted: AigentEvent[] = [];
  const counters: ResilienceCounters = { retries: 0, fallbacks: 0 };
  const events: ProviderEvent[] = [];
  for await (const event of openTurnStream({ routing, request: REQUEST, signal: new AbortController().signal, counters, emit: event => emitted.push(event) })) events.push(event);
  return { events, emitted, counters };
}

describe('openTurnStream', () => {
  it('streams the primary under a lease keyed by its label, with a token estimate, the lane and the agent', async () => {
    const provider = createFakeProvider({ turns: [textTurn('ok')] });
    const inner = createScheduler({});
    const leases: Omit<LeaseRequest, 'signal' | 'onQueued'>[] = [];
    const scheduler: Scheduler = { ...inner, acquire: request => { const { key, estimatedTokens, priority, agentName } = request; leases.push({ key, estimatedTokens, priority, agentName }); return inner.acquire(request); } };
    const { events } = await runTurnStream(routingFor({ targets: [targetFor({ provider, label: 'fake:m', settings: { maxOutputTokens: 50 } })], scheduler }));
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(provider.requests[0]).toMatchObject({ model: 'm', settings: { maxOutputTokens: 50 } });
    expect(leases).toEqual([{ key: 'fake:m', estimatedTokens: Math.ceil(JSON.stringify(REQUEST).length / 4) + 50, priority: 'background', agentName: 'helper' }]);
  });

  it('emits retry events and counts retries', async () => {
    const provider = createFakeProvider({ turns: [{ events: [], failBeforeEvents: RETRYABLE }, textTurn('ok')] });
    const { emitted, counters } = await runTurnStream(routingFor({ targets: [targetFor({ provider, label: 'fake:m' })] }));
    expect(emitted).toEqual([{ type: 'retry', attempt: 1, delayMs: 500, model: 'fake:m', reason: 'HTTP 503' }]);
    expect(counters).toEqual({ retries: 1, fallbacks: 0 });
  });

  it("emits a fallback event, then the fallback's setting warnings the first time the run uses it only", async () => {
    const primary = createFakeProvider({ turns: [{ events: [], failBeforeEvents: RETRYABLE }, { events: [], failBeforeEvents: RETRYABLE }] });
    const backup = createFakeProvider({ id: 'backup', turns: [textTurn('one'), textTurn('two')] });
    const routing = routingFor({ targets: [targetFor({ provider: primary, label: 'fake:m' }), targetFor({ provider: backup, label: 'backup:m', warnings: ['backup drops seed'] })], maxRetries: 0 });
    const first = await runTurnStream(routing);
    expect(first.emitted).toEqual([{ type: 'fallback', from: 'fake:m', to: 'backup:m', reason: 'HTTP 503' }, { type: 'warning', message: 'backup drops seed' }]);
    expect(first.counters).toEqual({ retries: 0, fallbacks: 1 });
    expect(routing.usedLabels).toEqual(new Set(['fake:m', 'backup:m']));
    const second = await runTurnStream(routing);
    expect(second.emitted).toEqual([{ type: 'fallback', from: 'fake:m', to: 'backup:m', reason: 'HTTP 503' }]);
  });

  it('forwards queueing as a queued event', async () => {
    const scheduler = createScheduler({ limits: { fake: { maxConcurrent: 1 } } });
    const holder = await scheduler.acquire({ key: 'fake:m', estimatedTokens: 1, priority: 'interactive', agentName: 'other', signal: new AbortController().signal });
    const provider = createFakeProvider({ turns: [textTurn('ok')] });
    const running = runTurnStream(routingFor({ targets: [targetFor({ provider, label: 'fake:m' })], scheduler }));
    await new Promise(resolve => setImmediate(resolve));
    holder.release();
    expect((await running).emitted).toEqual([{ type: 'queued', position: 1, reason: 'concurrency' }]);
  });
});
