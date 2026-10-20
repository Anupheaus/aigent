import { describe, expect, it } from 'vitest';
import { createFakeTime, flush } from './fake-time.test-support.js';
import type { FakeTime } from './fake-time.test-support.js';
import { createScheduler } from './scheduler.js';
import type { Lease, LeaseRequest, QueuedInfo, Scheduler, SchedulerOptions } from './scheduler-types.js';

interface Harness {
  time: FakeTime;
  scheduler: Scheduler;
}

function harness(options: Omit<SchedulerOptions, 'clock' | 'sleep'> = {}): Harness {
  const time = createFakeTime();
  return { time, scheduler: createScheduler({ ...options, clock: time.clock, sleep: time.sleep }) };
}

interface Tracked {
  lease: Promise<Lease>;
  queued: QueuedInfo[];
  /** True once the lease was granted. */
  isAdmitted(): boolean;
  controller: AbortController;
}

function request(scheduler: Scheduler, overrides: Partial<LeaseRequest> = {}): Tracked {
  const controller = new AbortController();
  const queued: QueuedInfo[] = [];
  let isAdmitted = false;
  const lease = scheduler.acquire({
    key: 'p:m', estimatedTokens: 10, priority: 'interactive', agentName: 'agent', signal: controller.signal,
    onQueued: info => queued.push(info), ...overrides,
  });
  lease.then(() => { isAdmitted = true; }, () => undefined);
  return { lease, queued, isAdmitted: () => isAdmitted, controller };
}

describe('createScheduler without limits', () => {
  it('admits every request at once without queueing', async () => {
    const { scheduler, time } = harness();
    const requests = Array.from({ length: 20 }, () => request(scheduler));
    await flush();
    expect(requests.every(tracked => tracked.isAdmitted())).toBe(true);
    expect(requests.every(tracked => tracked.queued.length === 0)).toBe(true);
    expect(scheduler.snapshot()).toEqual({ p: { inFlight: 20, queued: 0, interactiveQueued: 0, backgroundQueued: 0 } });
    for (const tracked of requests) (await tracked.lease).release();
    expect(scheduler.snapshot().p?.inFlight).toBe(0);
    expect(time.pendingSleeps()).toBe(0);
  });
});

describe('createScheduler concurrency', () => {
  it('queues past maxConcurrent with reason concurrency and admits on release', async () => {
    const { scheduler } = harness({ limits: { p: { maxConcurrent: 1 } } });
    const first = request(scheduler);
    const second = request(scheduler);
    await flush();
    expect(first.isAdmitted()).toBe(true);
    expect(second.isAdmitted()).toBe(false);
    expect(second.queued).toEqual([{ position: 1, reason: 'concurrency' }]);
    (await first.lease).release();
    await flush();
    expect(second.isAdmitted()).toBe(true);
  });

  it('ignores a second release of the same lease', async () => {
    const { scheduler } = harness({ limits: { p: { maxConcurrent: 1 } } });
    const first = await request(scheduler).lease;
    const second = request(scheduler);
    const third = request(scheduler);
    first.release();
    first.release();
    await flush();
    expect(second.isAdmitted()).toBe(true);
    expect(third.isAdmitted()).toBe(false);
    expect(scheduler.snapshot().p).toMatchObject({ inFlight: 1, queued: 1 });
  });
});

describe('createScheduler lanes and fairness', () => {
  it('admits interactive requests before background ones', async () => {
    const { scheduler } = harness({ limits: { p: { maxConcurrent: 1 } } });
    const holder = await request(scheduler).lease;
    const order: string[] = [];
    const background = request(scheduler, { priority: 'background' });
    const interactive = request(scheduler, { priority: 'interactive' });
    void background.lease.then(lease => { order.push('background'); lease.release(); });
    void interactive.lease.then(lease => { order.push('interactive'); lease.release(); });
    expect(scheduler.snapshot().p).toMatchObject({ interactiveQueued: 1, backgroundQueued: 1, queued: 2 });
    holder.release();
    await flush();
    expect(order).toEqual(['interactive', 'background']);
  });

  it("does not let a noisy agent delay another agent's first request by more than one admission", async () => {
    const { scheduler } = harness({ limits: { p: { maxConcurrent: 1 } } });
    const holder = await request(scheduler, { agentName: 'other' }).lease;
    const order: string[] = [];
    const admitThenRelease = (tracked: Tracked, name: string): void => { void tracked.lease.then(lease => { order.push(name); lease.release(); }); };
    for (let index = 0; index < 50; index += 1) admitThenRelease(request(scheduler, { agentName: 'noisy' }), `noisy-${index}`);
    admitThenRelease(request(scheduler, { agentName: 'quiet' }), 'quiet');
    holder.release();
    await flush();
    expect(order).toHaveLength(51);
    expect(order.indexOf('quiet')).toBeLessThanOrEqual(1);
  });

  it('serves the agent that was served least recently first', async () => {
    const { scheduler } = harness({ limits: { p: { maxConcurrent: 1 } } });
    const holder = await request(scheduler, { agentName: 'noisy' }).lease;
    const order: string[] = [];
    for (const name of ['noisy', 'noisy', 'quiet']) void request(scheduler, { agentName: name }).lease.then(lease => { order.push(name); lease.release(); });
    holder.release();
    await flush();
    expect(order).toEqual(['quiet', 'noisy', 'noisy']);
  });

  it('promotes a background request that waited maxBackgroundWaitMs ahead of newer interactive ones', async () => {
    const { scheduler, time } = harness({ limits: { p: { maxConcurrent: 1 } }, maxBackgroundWaitMs: 1_000 });
    const holder = await request(scheduler).lease;
    const order: string[] = [];
    void request(scheduler, { priority: 'background' }).lease.then(lease => { order.push('background'); lease.release(); });
    await time.advance(500);
    void request(scheduler).lease.then(lease => { order.push('interactive'); lease.release(); });
    await time.advance(600);
    holder.release();
    await flush();
    expect(order).toEqual(['background', 'interactive']);
  });

  it('keeps a background request behind interactive ones before maxBackgroundWaitMs', async () => {
    const { scheduler, time } = harness({ limits: { p: { maxConcurrent: 1 } }, maxBackgroundWaitMs: 1_000 });
    const holder = await request(scheduler).lease;
    const order: string[] = [];
    void request(scheduler, { priority: 'background' }).lease.then(lease => { order.push('background'); lease.release(); });
    await time.advance(500);
    void request(scheduler).lease.then(lease => { order.push('interactive'); lease.release(); });
    holder.release();
    await flush();
    expect(order).toEqual(['interactive', 'background']);
  });
});

describe('createScheduler per-minute budgets', () => {
  it('waits for the request budget, reporting requests-per-minute and the wait', async () => {
    const { scheduler, time } = harness({ limits: { p: { requestsPerMinute: 2 } } });
    (await request(scheduler).lease).release();
    await time.advance(10_000);
    (await request(scheduler).lease).release();
    const third = request(scheduler);
    await flush();
    expect(third.queued).toEqual([{ position: 1, reason: 'requests-per-minute', waitMs: 50_000 }]);
    await time.advance(49_999);
    expect(third.isAdmitted()).toBe(false);
    await time.advance(1);
    expect(third.isAdmitted()).toBe(true);
  });

  it('waits for the token budget and reconciles estimates with actual usage on release', async () => {
    const { scheduler, time } = harness({ limits: { p: { tokensPerMinute: 1_000 } } });
    const first = await request(scheduler, { estimatedTokens: 900 }).lease;
    const second = request(scheduler, { estimatedTokens: 500 });
    await flush();
    expect(second.queued).toEqual([{ position: 1, reason: 'tokens-per-minute', waitMs: 60_000 }]);
    first.release({ tokens: 300 });
    await flush();
    expect(second.isAdmitted()).toBe(true);
    expect(time.pendingSleeps()).toBe(0);
  });

  it('counts reported usage against the token budget', async () => {
    const { scheduler } = harness({ limits: { p: { tokensPerMinute: 1_000 } } });
    scheduler.reportUsage({ key: 'p:m', tokens: 950 });
    const blocked = request(scheduler, { estimatedTokens: 100 });
    await flush();
    expect(blocked.queued).toEqual([expect.objectContaining({ reason: 'tokens-per-minute' })]);
  });
});

describe('createScheduler abort', () => {
  it('removes an aborted queued request, rejects it as aborted and consumes no budget', async () => {
    const { scheduler, time } = harness({ limits: { p: { requestsPerMinute: 1, tokensPerMinute: 100 } } });
    const holder = await request(scheduler, { estimatedTokens: 50 }).lease;
    const queued = request(scheduler, { estimatedTokens: 50 });
    await flush();
    queued.controller.abort();
    await expect(queued.lease).rejects.toMatchObject({ code: 'aborted' });
    expect(scheduler.snapshot().p).toMatchObject({ queued: 0, inFlight: 1 });
    expect(time.pendingSleeps()).toBe(0);
    holder.release();
    await time.advance(60_000);
    const next = request(scheduler, { estimatedTokens: 100 });
    await flush();
    expect(next.isAdmitted()).toBe(true);
  });

  it('rejects at once for an already aborted signal', async () => {
    const { scheduler } = harness({ limits: { p: { maxConcurrent: 1 } } });
    const controller = new AbortController();
    controller.abort();
    await expect(scheduler.acquire({ key: 'p:m', estimatedTokens: 1, priority: 'interactive', agentName: 'a', signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(scheduler.snapshot().p).toMatchObject({ queued: 0, inFlight: 0 });
  });

  it('lets a request behind an aborted one move up', async () => {
    const { scheduler } = harness({ limits: { p: { tokensPerMinute: 100 } } });
    await request(scheduler, { estimatedTokens: 60 }).lease;
    const big = request(scheduler, { estimatedTokens: 50 });
    const small = request(scheduler, { estimatedTokens: 40, agentName: 'agent' });
    await flush();
    expect(small.isAdmitted()).toBe(false);
    big.controller.abort();
    await flush();
    expect(small.isAdmitted()).toBe(true);
  });
});

describe('createScheduler onQueued', () => {
  it('rejects with the callback error and leaves nothing queued or in flight when onQueued throws', async () => {
    const { scheduler } = harness({ limits: { p: { maxConcurrent: 1 } } });
    const holder = request(scheduler);
    await flush();
    const thrown = new Error('listener broke');
    const failing = scheduler.acquire({
      key: 'p:m', estimatedTokens: 10, priority: 'interactive', agentName: 'agent', signal: new AbortController().signal,
      onQueued: () => { throw thrown; },
    });
    await expect(failing).rejects.toBe(thrown);
    expect(scheduler.snapshot().p).toMatchObject({ inFlight: 1, queued: 0 });
    (await holder.lease).release();
    expect(scheduler.snapshot().p).toMatchObject({ inFlight: 0, queued: 0 });
    const next = request(scheduler);
    await flush();
    expect(next.isAdmitted()).toBe(true);
  });
});

describe('createScheduler rate-limit adaptation', () => {
  it('pauses the key for retryAfterMs', async () => {
    const { scheduler, time } = harness();
    scheduler.reportRateLimit({ key: 'p:m', retryAfterMs: 5_000 });
    const paused = request(scheduler);
    await flush();
    expect(paused.queued).toEqual([{ position: 1, reason: 'requests-per-minute', waitMs: 5_000 }]);
    await time.advance(4_999);
    expect(paused.isAdmitted()).toBe(false);
    await time.advance(1);
    expect(paused.isAdmitted()).toBe(true);
  });

  it('halves the effective concurrency for the next 10 admissions', async () => {
    const { scheduler, time } = harness({ limits: { p: { maxConcurrent: 4 } } });
    scheduler.reportRateLimit({ key: 'p:m', retryAfterMs: 0 });
    await time.advance(0);
    const granted: Lease[] = [];
    for (let index = 0; index < 16; index += 1) void request(scheduler).lease.then(lease => granted.push(lease));
    await flush();
    const inFlightSeen: number[] = [];
    while (granted.length > 0) {
      inFlightSeen.push(scheduler.snapshot().p?.inFlight ?? 0);
      for (const lease of granted.splice(0)) lease.release();
      await flush();
    }
    // Admissions 1-10 run at half concurrency: 2 at first, then 2 per step for four steps. The 10th admission ends
    // the halving, so the same release admits two more at once and full concurrency (4) is back.
    expect(inFlightSeen).toEqual([2, 2, 2, 2, 4, 4]);
  });
});

describe('createScheduler limit keys', () => {
  it('uses the most specific limits: provider:model, then provider, then defaultLimits', async () => {
    const { scheduler } = harness({ limits: { p: { maxConcurrent: 1 }, 'p:big': { maxConcurrent: 3 } }, defaultLimits: { maxConcurrent: 2 } });
    const big = Array.from({ length: 4 }, () => request(scheduler, { key: 'p:big' }));
    const small = Array.from({ length: 2 }, () => request(scheduler, { key: 'p:small' }));
    const other = Array.from({ length: 3 }, () => request(scheduler, { key: 'q:any' }));
    await flush();
    const admitted = (group: Tracked[]): number => group.filter(tracked => tracked.isAdmitted()).length;
    expect([admitted(big), admitted(small), admitted(other)]).toEqual([3, 1, 2]);
    expect(scheduler.snapshot()).toEqual({
      'p:big': { inFlight: 3, queued: 1, interactiveQueued: 1, backgroundQueued: 0 },
      p: { inFlight: 1, queued: 1, interactiveQueued: 1, backgroundQueued: 0 },
      q: { inFlight: 2, queued: 1, interactiveQueued: 1, backgroundQueued: 0 },
    });
  });
});
