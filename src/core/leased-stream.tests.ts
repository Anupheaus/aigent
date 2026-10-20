import { describe, expect, it } from 'vitest';
import type { ProviderEvent } from '../providers/provider-types.js';
import { createScheduler } from '../scheduler/scheduler.js';
import type { QueuedInfo, Scheduler } from '../scheduler/scheduler-types.js';
import { createAigentError } from './aigent-error.js';
import { leasedStream } from './leased-stream.js';
import type { LeasedStreamParams } from './leased-stream.js';

const KEY = 'p:m';
const TEXT: ProviderEvent = { type: 'text-delta', text: 'hi' };
const USAGE: ProviderEvent = { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, cachedTokens: 0 } };
const DONE: ProviderEvent = { type: 'done', finishReason: 'stop' };

async function* scripted(events: ProviderEvent[]): AsyncGenerator<ProviderEvent> {
  for (const event of events) yield event;
}

function singleSlotScheduler(): Scheduler {
  return createScheduler({ limits: { p: { maxConcurrent: 1 } } });
}

function params(overrides: Partial<LeasedStreamParams> & Pick<LeasedStreamParams, 'scheduler' | 'open'>): LeasedStreamParams {
  return {
    lease: { key: KEY, estimatedTokens: 10, priority: 'interactive', agentName: 'agent' },
    signal: new AbortController().signal,
    onQueued: () => undefined,
    sleep: async () => undefined,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const seen: ProviderEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe('leasedStream', () => {
  it('streams under a lease and releases it with the actual usage when the stream ends', async () => {
    const scheduler = singleSlotScheduler();
    const released: unknown[] = [];
    const spy: Scheduler = { ...scheduler, acquire: async request => { const lease = await scheduler.acquire(request); return { release: actual => { released.push(actual); lease.release(actual); } }; } };
    expect(await collect(leasedStream(params({ scheduler: spy, open: () => scripted([TEXT, USAGE, DONE]) })))).toEqual([TEXT, USAGE, DONE]);
    expect(released).toEqual([{ tokens: 10 }]);
    expect(scheduler.snapshot().p).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('releases the lease when open throws synchronously, rethrowing the error', async () => {
    const scheduler = singleSlotScheduler();
    const thrown = createAigentError({ code: 'provider_failed', message: 'no key', details: { retryable: false } });
    await expect(collect(leasedStream(params({ scheduler, open: () => { throw thrown; } })))).rejects.toBe(thrown);
    expect(scheduler.snapshot().p).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('releases the lease when open throws synchronously behind a first-event timeout', async () => {
    const scheduler = singleSlotScheduler();
    const thrown = createAigentError({ code: 'provider_failed', message: 'no key', details: { retryable: false } });
    await expect(collect(leasedStream(params({ scheduler, firstEventTimeoutMs: 1_000, open: () => { throw thrown; } })))).rejects.toBe(thrown);
    expect(scheduler.snapshot().p).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('releases the lease when open returns a non-iterable', async () => {
    const scheduler = singleSlotScheduler();
    const open = (() => 42) as unknown as LeasedStreamParams['open'];
    await expect(collect(leasedStream(params({ scheduler, open })))).rejects.toMatchObject({ code: 'provider_failed', details: { retryable: false } });
    expect(scheduler.snapshot().p).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('pauses the key when open throws a 429 synchronously', async () => {
    const scheduler = singleSlotScheduler();
    const reports: unknown[] = [];
    const spy: Scheduler = { ...scheduler, reportRateLimit: report => { reports.push(report); } };
    const limited = createAigentError({ code: 'provider_failed', message: 'HTTP 429', details: { status: 429, retryable: true, retryAfterMs: 3_000 } });
    await expect(collect(leasedStream(params({ scheduler: spy, open: () => { throw limited; } })))).rejects.toBe(limited);
    expect(reports).toEqual([{ key: KEY, retryAfterMs: 3_000 }]);
  });

  it('pauses the key for 1 s when a 429 has no retry-after', async () => {
    const scheduler = singleSlotScheduler();
    const reports: unknown[] = [];
    const spy: Scheduler = { ...scheduler, reportRateLimit: report => { reports.push(report); } };
    const limited = createAigentError({ code: 'provider_failed', message: 'HTTP 429', details: { status: 429, retryable: true } });
    async function* failing(): AsyncGenerator<ProviderEvent> { throw limited; }
    await expect(collect(leasedStream(params({ scheduler: spy, open: failing })))).rejects.toBe(limited);
    expect(reports).toEqual([{ key: KEY, retryAfterMs: 1_000 }]);
  });

  it('releases the lease and stops the stream when the consumer stops early', async () => {
    const scheduler = singleSlotScheduler();
    let isReturned = false;
    async function* endless(): AsyncGenerator<ProviderEvent> {
      try { for (;;) yield TEXT; } finally { isReturned = true; }
    }
    for await (const event of leasedStream(params({ scheduler, open: endless }))) if (event.type === 'text-delta') break;
    await new Promise(resolve => setImmediate(resolve));
    expect(isReturned).toBe(true);
    expect(scheduler.snapshot().p).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('rejects aborted and releases the lease when the signal aborts, even if the provider ignores it', async () => {
    const scheduler = singleSlotScheduler();
    const controller = new AbortController();
    async function* ignoresAbort(): AsyncGenerator<ProviderEvent> {
      yield TEXT;
      await new Promise(() => undefined);
    }
    const seen: ProviderEvent[] = [];
    const run = (async (): Promise<void> => {
      for await (const event of leasedStream(params({ scheduler, open: ignoresAbort, signal: controller.signal }))) {
        seen.push(event);
        controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ code: 'aborted' });
    expect(seen).toEqual([TEXT]);
    expect(scheduler.snapshot().p).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('reports queueing through onQueued while another call holds the only slot', async () => {
    const scheduler = singleSlotScheduler();
    const holder = await scheduler.acquire({ key: KEY, estimatedTokens: 1, priority: 'interactive', agentName: 'holder', signal: new AbortController().signal });
    const queued: QueuedInfo[] = [];
    const run = collect(leasedStream(params({ scheduler, open: () => scripted([DONE]), onQueued: info => queued.push(info) })));
    await new Promise(resolve => setImmediate(resolve));
    expect(queued).toEqual([{ position: 1, reason: 'concurrency' }]);
    holder.release();
    expect(await run).toEqual([DONE]);
  });
});
