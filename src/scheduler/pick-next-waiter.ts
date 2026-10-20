import type { LanePriority } from './scheduler-types.js';

/** What the queue order needs to know about a waiting request. */
export interface QueuedRequest {
  agentName: string;
  priority: LanePriority;
  enqueuedAt: number;
  /** Arrival order; breaks ties so the queue is stable. */
  sequence: number;
}

export interface PickNextParams<T extends QueuedRequest> {
  /** In arrival order. */
  waiters: T[];
  now: number;
  maxBackgroundWaitMs: number;
  /** Admission counter value when each agent was last admitted; agents never admitted are absent. */
  lastServed: ReadonlyMap<string, number>;
}

/** Never-admitted agents rank before every admitted one. */
const NEVER_SERVED = -1;

function laneOf(params: { waiter: QueuedRequest; now: number; maxBackgroundWaitMs: number }): LanePriority {
  const { waiter: { priority, enqueuedAt }, now, maxBackgroundWaitMs } = params;
  // A background request that has waited long enough is promoted, so a steady interactive load cannot starve it.
  return priority === 'interactive' || now - enqueuedAt >= maxBackgroundWaitMs ? 'interactive' : 'background';
}

/**
 * The request to admit next: the interactive lane (including promoted background requests) before the background
 * lane; within the lane, the oldest request of the agent admitted least recently, so one agent flooding the queue
 * delays another agent's request by at most one admission.
 */
export function pickNextWaiter<T extends QueuedRequest>(params: PickNextParams<T>): T | undefined {
  const { waiters, now, maxBackgroundWaitMs, lastServed } = params;
  const interactive = waiters.filter(waiter => laneOf({ waiter, now, maxBackgroundWaitMs }) === 'interactive');
  const lane = interactive.length > 0 ? interactive : waiters;
  let best: T | undefined;
  for (const waiter of lane) {
    if (best == null) { best = waiter; continue; }
    const waiterServed = lastServed.get(waiter.agentName) ?? NEVER_SERVED;
    const bestServed = lastServed.get(best.agentName) ?? NEVER_SERVED;
    if (waiterServed < bestServed || (waiterServed === bestServed && waiter.sequence < best.sequence)) best = waiter;
  }
  return best;
}
