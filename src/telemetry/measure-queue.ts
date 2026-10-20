import type { Lease, LeaseRequest, Scheduler } from '../scheduler/scheduler-types.js';

export interface MeasureQueueWaitParams {
  scheduler: Scheduler;
  now(): number;
  /** Called with how long each `acquire` waited, admitted or not. */
  onWait(waitedMs: number): void;
}

/** The same scheduler, reporting how long each provider call waited for admission (the run's `queuedMs`). */
export function measureQueueWait(params: MeasureQueueWaitParams): Scheduler {
  const { scheduler, now, onWait } = params;
  async function acquire(request: LeaseRequest): Promise<Lease> {
    const startedAt = now();
    try {
      return await scheduler.acquire(request);
    } finally {
      onWait(now() - startedAt);
    }
  }
  return { ...scheduler, acquire };
}
