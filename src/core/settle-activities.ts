import { raceSignal } from './race-signal.js';

export interface SettleActivitiesParams {
  activities: Promise<void>[];
  /** The run's signal; once it aborts there is nothing left worth waiting for. */
  signal: AbortSignal;
  /** Longest wait, in milliseconds. */
  graceMs: number;
}

/**
 * Waits for a turn's activity renderers, but never longer than `graceMs` and not at all once the run is aborted,
 * because renderers are consumer code and must never hold a run open. Resolves true when every renderer settled.
 */
export async function settleActivities(params: SettleActivitiesParams): Promise<boolean> {
  const { activities, signal, graceMs } = params;
  if (activities.length === 0) return true;
  const deadline = new AbortController();
  const expire = (): void => deadline.abort();
  const timer = setTimeout(expire, graceMs);
  signal.addEventListener('abort', expire, { once: true });
  if (signal.aborted) expire();
  try {
    const raced = await raceSignal({ work: Promise.all(activities), signal: deadline.signal });
    return !raced.isAborted;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', expire);
  }
}
