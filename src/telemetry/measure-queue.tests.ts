import { describe, expect, it } from 'vitest';
import type { LeaseRequest, Scheduler } from '../scheduler/scheduler-types.js';
import { measureQueueWait } from './measure-queue.js';

const REQUEST: LeaseRequest = { key: 'fake:m', estimatedTokens: 1, priority: 'interactive', agentName: 'a', signal: new AbortController().signal };

function delayedScheduler(params: { advance(ms: number): void; waitMs: number; fails?: boolean }): Scheduler {
  const { advance, waitMs, fails = false } = params;
  return {
    acquire: async () => { advance(waitMs); if (fails) throw new Error('aborted while queued'); return { release: () => undefined }; },
    reportRateLimit: () => undefined,
    reportUsage: () => undefined,
    snapshot: () => ({}),
  };
}

describe('measureQueueWait', () => {
  it('reports how long each acquire waited and passes the lease through', async () => {
    let now = 0;
    const waits: number[] = [];
    const scheduler = measureQueueWait({ scheduler: delayedScheduler({ advance: ms => { now += ms; }, waitMs: 30 }), now: () => now, onWait: ms => waits.push(ms) });
    const lease = await scheduler.acquire(REQUEST);
    expect(typeof lease.release).toBe('function');
    expect(waits).toEqual([30]);
  });

  it('still reports the wait when the acquire is rejected', async () => {
    let now = 0;
    const waits: number[] = [];
    const scheduler = measureQueueWait({ scheduler: delayedScheduler({ advance: ms => { now += ms; }, waitMs: 12, fails: true }), now: () => now, onWait: ms => waits.push(ms) });
    await expect(scheduler.acquire(REQUEST)).rejects.toThrow('aborted while queued');
    expect(waits).toEqual([12]);
  });
});
