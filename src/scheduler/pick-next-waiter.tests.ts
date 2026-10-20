import { describe, expect, it } from 'vitest';
import { pickNextWaiter, queuePosition } from './pick-next-waiter.js';
import type { QueuedRequest } from './pick-next-waiter.js';
import type { LanePriority } from './scheduler-types.js';

const MAX_BACKGROUND_WAIT_MS = 1_000;

function waiter(params: { agentName: string; sequence: number; priority?: LanePriority; enqueuedAt?: number }): QueuedRequest {
  const { agentName, sequence, priority = 'interactive', enqueuedAt = 0 } = params;
  return { agentName, sequence, priority, enqueuedAt };
}

describe('pickNextWaiter', () => {
  it('returns undefined for an empty queue', () => {
    expect(pickNextWaiter({ waiters: [], now: 0, maxBackgroundWaitMs: MAX_BACKGROUND_WAIT_MS, lastServed: new Map() })).toBeUndefined();
  });

  it('picks the oldest request among agents never served', () => {
    const first = waiter({ agentName: 'a', sequence: 1 });
    const second = waiter({ agentName: 'b', sequence: 2 });
    expect(pickNextWaiter({ waiters: [second, first], now: 0, maxBackgroundWaitMs: MAX_BACKGROUND_WAIT_MS, lastServed: new Map() })).toBe(first);
  });

  it('prefers interactive over background', () => {
    const background = waiter({ agentName: 'a', sequence: 1, priority: 'background' });
    const interactive = waiter({ agentName: 'b', sequence: 2 });
    expect(pickNextWaiter({ waiters: [background, interactive], now: 0, maxBackgroundWaitMs: MAX_BACKGROUND_WAIT_MS, lastServed: new Map() })).toBe(interactive);
  });

  it('treats a background request waiting maxBackgroundWaitMs as interactive', () => {
    const background = waiter({ agentName: 'a', sequence: 1, priority: 'background', enqueuedAt: 0 });
    const interactive = waiter({ agentName: 'b', sequence: 2, enqueuedAt: 900 });
    const waiters = [background, interactive];
    expect(pickNextWaiter({ waiters, now: 999, maxBackgroundWaitMs: MAX_BACKGROUND_WAIT_MS, lastServed: new Map() })).toBe(interactive);
    expect(pickNextWaiter({ waiters, now: 1_000, maxBackgroundWaitMs: MAX_BACKGROUND_WAIT_MS, lastServed: new Map() })).toBe(background);
  });

  it('picks the agent served least recently, never-served first', () => {
    const busy = waiter({ agentName: 'busy', sequence: 1 });
    const idle = waiter({ agentName: 'idle', sequence: 2 });
    const fresh = waiter({ agentName: 'fresh', sequence: 3 });
    const lastServed = new Map([['busy', 5], ['idle', 2]]);
    expect(pickNextWaiter({ waiters: [busy, idle, fresh], now: 0, maxBackgroundWaitMs: MAX_BACKGROUND_WAIT_MS, lastServed })).toBe(fresh);
    expect(pickNextWaiter({ waiters: [busy, idle], now: 0, maxBackgroundWaitMs: MAX_BACKGROUND_WAIT_MS, lastServed })).toBe(idle);
  });
});

describe('queuePosition', () => {
  it('ranks by admission order, not arrival', () => {
    const background = [1, 2, 3].map(sequence => waiter({ agentName: 'batch', sequence, priority: 'background' }));
    const interactive = waiter({ agentName: 'user', sequence: 4 });
    const waiters = [...background, interactive];
    const params = { waiters, now: 0, maxBackgroundWaitMs: MAX_BACKGROUND_WAIT_MS, lastServed: new Map<string, number>() };
    expect(queuePosition({ ...params, waiter: interactive })).toBe(1);
    expect(background.map(queued => queuePosition({ ...params, waiter: queued }))).toEqual([2, 3, 4]);
  });

  it('alternates agents as fairness would, counting each pick as an admission', () => {
    const noisy = [1, 2, 3].map(sequence => waiter({ agentName: 'noisy', sequence }));
    const quiet = [4, 5].map(sequence => waiter({ agentName: 'quiet', sequence }));
    const waiters = [...noisy, ...quiet];
    const params = { waiters, now: 0, maxBackgroundWaitMs: MAX_BACKGROUND_WAIT_MS, lastServed: new Map([['noisy', 1]]) };
    // quiet (never served), then noisy, quiet, noisy, noisy.
    expect(waiters.map(queued => queuePosition({ ...params, waiter: queued }))).toEqual([2, 4, 5, 1, 3]);
  });

  it('places a request that is not in the queue after everything in it', () => {
    const queued = waiter({ agentName: 'a', sequence: 1 });
    const outsider = waiter({ agentName: 'b', sequence: 2 });
    expect(queuePosition({ waiter: outsider, waiters: [queued], now: 0, maxBackgroundWaitMs: MAX_BACKGROUND_WAIT_MS, lastServed: new Map() })).toBe(2);
  });
});
