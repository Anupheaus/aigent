import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createScheduler } from '../scheduler/scheduler.js';
import type { LeaseRequest, Scheduler } from '../scheduler/scheduler-types.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeProvider } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { createAigentError } from './aigent-error.js';
import { createAigent } from './create-aigent.js';
import type { AigentOptions } from './create-aigent.js';
import type { AigentEvent } from './aigent-events.js';
import type { IdGenerator } from './runtime-services.js';

function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function aigentWith(params: { providers: FakeProvider[]; options?: Partial<AigentOptions> }) {
  const { providers, options } = params;
  return createAigent({ providers, ids: sequentialIds(), sleep: async () => undefined, random: () => 0.5, ...options });
}

const SLOW_MS = 30;

interface SpyScheduler extends Scheduler {
  requests: Omit<LeaseRequest, 'signal' | 'onQueued'>[];
  releases: unknown[];
  rateLimits: unknown[];
}

/** Wraps a real scheduler and records what the run asks of it. */
function spyScheduler(inner: Scheduler): SpyScheduler {
  const requests: SpyScheduler['requests'] = [];
  const releases: unknown[] = [];
  const rateLimits: unknown[] = [];
  return {
    requests, releases, rateLimits,
    acquire: async leaseRequest => {
      const { key, estimatedTokens, priority, agentName } = leaseRequest;
      requests.push({ key, estimatedTokens, priority, agentName });
      const lease = await inner.acquire(leaseRequest);
      return { release: actual => { releases.push(actual); lease.release(actual); } };
    },
    reportRateLimit: report => { rateLimits.push(report); inner.reportRateLimit(report); },
    reportUsage: report => inner.reportUsage(report),
    snapshot: () => inner.snapshot(),
  };
}

describe('scheduler through createAigent', () => {
  it('runs two agents sharing a maxConcurrent 1 scheduler one at a time; only the waiting one sees queued', async () => {
    const scheduler = createScheduler({ limits: { fake: { maxConcurrent: 1 } } });
    const provider = createFakeProvider({ turns: [textTurn('first', { delayMs: SLOW_MS }), textTurn('second', { delayMs: SLOW_MS })] });
    const ai = aigentWith({ providers: [provider], options: { scheduler } });
    const firstRun = ai.agent({ name: 'one', model: 'fake:m' }).task({ task: 'x' });
    const secondRun = ai.agent({ name: 'two', model: 'fake:m' }).task({ task: 'y' });
    const [firstEvents, secondEvents] = await Promise.all([collect(firstRun), collect(secondRun)]);
    expect((await firstRun).answer).toBe('first');
    expect((await secondRun).answer).toBe('second');
    expect(firstEvents.some(event => event.type === 'queued')).toBe(false);
    expect(secondEvents.filter(event => event.type === 'queued')).toEqual([{ type: 'queued', position: 1, reason: 'concurrency' }]);
    expect(scheduler.snapshot().fake).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('imposes no waiting with the default scheduler', async () => {
    const provider = createFakeProvider({ turns: [textTurn('a', { delayMs: SLOW_MS }), textTurn('b', { delayMs: SLOW_MS })] });
    const ai = aigentWith({ providers: [provider] });
    const runs = [ai.agent({ name: 'one', model: 'fake:m' }).task({ task: 'x' }), ai.agent({ name: 'two', model: 'fake:m' }).task({ task: 'y' })];
    const events = (await Promise.all(runs.map(collect))).flat();
    expect(events.some(event => event.type === 'queued')).toBe(false);
  });

  it('accepts SchedulerOptions and builds a scheduler from them', async () => {
    const provider = createFakeProvider({ turns: [textTurn('a', { delayMs: SLOW_MS }), textTurn('b')] });
    const ai = aigentWith({ providers: [provider], options: { scheduler: { limits: { fake: { maxConcurrent: 1 } } } } });
    const first = ai.agent({ name: 'one', model: 'fake:m' }).task({ task: 'x' });
    const secondEvents = await collect(ai.agent({ name: 'two', model: 'fake:m' }).task({ task: 'y' }));
    await first;
    expect(secondEvents).toContainEqual(expect.objectContaining({ type: 'queued', reason: 'concurrency' }));
  });

  it('acquires per provider call with the model key, a token estimate and the task priority, releasing with actual usage', async () => {
    const scheduler = spyScheduler(createScheduler({}));
    const provider = createFakeProvider({ turns: [textTurn('a'), textTurn('b')] });
    const ai = aigentWith({ providers: [provider], options: { scheduler } });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', modelSettings: { maxOutputTokens: 100 } });
    await agent.task({ task: 'x' });
    await agent.task({ task: 'y', unattended: true });
    const request = provider.requests[0]!;
    const expectedEstimate = Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4) + 100;
    expect(scheduler.requests).toEqual([
      { key: 'fake:m', estimatedTokens: expectedEstimate, priority: 'interactive', agentName: 'helper' },
      expect.objectContaining({ key: 'fake:m', priority: 'background', agentName: 'helper' }),
    ]);
    expect(scheduler.releases).toEqual([{ tokens: 15 }, { tokens: 15 }]);
  });

  it('lets a task override its priority', async () => {
    const scheduler = spyScheduler(createScheduler({}));
    const ai = aigentWith({ providers: [createFakeProvider({ turns: [textTurn('a')] })], options: { scheduler } });
    await ai.agent({ name: 'helper', model: 'fake:m' }).task({ task: 'x', unattended: true, priority: 'interactive' });
    expect(scheduler.requests[0]?.priority).toBe('interactive');
  });

  it('rejects an unknown priority as invalid input', () => {
    const agent = aigentWith({ providers: [createFakeProvider({ turns: [] })] }).agent({ name: 'helper', model: 'fake:m' });
    expect(() => agent.task({ task: 'x', priority: 'urgent' as 'interactive' })).toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('priority') }));
  });

  it('reports a 429 retry-after to the scheduler and acquires again for the retry', async () => {
    const scheduler = spyScheduler(createScheduler({}));
    const limited = createAigentError({ code: 'provider_failed', message: 'HTTP 429', details: { status: 429, retryable: true, retryAfterMs: 2_000 } });
    const provider = createFakeProvider({ turns: [{ events: [], failBeforeEvents: limited }, textTurn('ok')] });
    const ai = aigentWith({ providers: [provider], options: { scheduler } });
    const result = await ai.agent({ name: 'helper', model: 'fake:m' }).task({ task: 'x' });
    expect(result).toMatchObject({ status: 'completed', usage: { retries: 1 } });
    expect(scheduler.rateLimits).toEqual([{ key: 'fake:m', retryAfterMs: 2_000 }]);
    expect(scheduler.requests).toHaveLength(2);
    expect(scheduler.releases).toEqual([undefined, { tokens: 15 }]);
  });

  it('releases the lease when the provider fails, leaving nothing in flight', async () => {
    const scheduler = createScheduler({ limits: { fake: { maxConcurrent: 1 } } });
    const fatal = createAigentError({ code: 'provider_failed', message: 'HTTP 400', details: { status: 400, retryable: false } });
    const ai = aigentWith({ providers: [createFakeProvider({ turns: [{ events: [], failBeforeEvents: fatal }] })], options: { scheduler } });
    expect((await ai.agent({ name: 'helper', model: 'fake:m' }).task({ task: 'x' })).status).toBe('failed');
    expect(scheduler.snapshot().fake).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('releases the lease when the run is cancelled mid-stream', async () => {
    const scheduler = createScheduler({ limits: { fake: { maxConcurrent: 1 } } });
    const ai = aigentWith({ providers: [createFakeProvider({ turns: [textTurn('slow text', { chunkSize: 1, delayMs: 50 })] })], options: { scheduler } });
    const run = ai.agent({ name: 'helper', model: 'fake:m' }).task({ task: 'x' });
    setTimeout(() => run.cancel(), 20);
    expect((await run).status).toBe('cancelled');
    expect(scheduler.snapshot().fake).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('settles a run cancelled while queued promptly, leaving nothing queued', async () => {
    const scheduler = createScheduler({ limits: { fake: { maxConcurrent: 1 } } });
    const holder = await scheduler.acquire({ key: 'fake:m', estimatedTokens: 1, priority: 'interactive', agentName: 'holder', signal: new AbortController().signal });
    const provider = createFakeProvider({ turns: [textTurn('never')] });
    const ai = aigentWith({ providers: [provider], options: { scheduler } });
    const run = ai.agent({ name: 'helper', model: 'fake:m' }).task({ task: 'x' });
    for await (const event of run) if (event.type === 'queued') run.cancel();
    expect((await run).status).toBe('cancelled');
    expect(provider.requests).toHaveLength(0);
    expect(scheduler.snapshot().fake).toMatchObject({ inFlight: 1, queued: 0 });
    holder.release();
    expect(scheduler.snapshot().fake).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('holds a lease only while the provider streams, not while tools run', async () => {
    const scheduler = createScheduler({ limits: { fake: { maxConcurrent: 1 } } });
    let inFlightDuringTool = -1;
    const probe = defineTool({
      name: 'probe', description: 'p', args: z.object({}).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 'p' }),
      run: async () => { await new Promise(resolve => setTimeout(resolve, 10)); inFlightDuringTool = scheduler.snapshot().fake?.inFlight ?? 0; return 'ok'; },
    });
    const provider = createFakeProvider({ turns: [toolTurn([{ id: 'c1', name: 'probe', args: {} }]), textTurn('done')] });
    const ai = aigentWith({ providers: [provider], options: { scheduler } });
    expect((await ai.agent({ name: 'helper', model: 'fake:m', tools: [probe] }).task({ task: 'x' })).status).toBe('completed');
    expect(inFlightDuringTool).toBe(0);
  });
});
