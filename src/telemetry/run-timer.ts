import type { RunTimings } from './run-record.js';

/** The timings measured while the run is going; the rest are derived from its result and trace. */
export type MeasuredTimings = Omit<RunTimings, 'durationMs' | 'toolMs'>;

/** Ends a turn's model timing. */
export type EndTurn = () => void;

export interface RunTimer {
  /** Notes the first streamed text, thinking or tool call; later calls are ignored. */
  markFirstToken(): void;
  /** Starts timing one model request; its queued time is subtracted when it ends. */
  startTurn(): EndTurn;
  addQueuedMs(ms: number): void;
  snapshot(): MeasuredTimings;
}

export interface CreateRunTimerParams {
  now(): number;
}

export function createRunTimer(params: CreateRunTimerParams): RunTimer {
  const { now } = params;
  const startedAt = now();
  let firstTokenMs: number | undefined;
  let modelMs = 0;
  let queuedMs = 0;

  function startTurn(): EndTurn {
    const turnStartedAt = now();
    const queuedBefore = queuedMs;
    return () => {
      // Time waiting for the scheduler is not model time; it is reported as queuedMs instead.
      modelMs += Math.max(0, now() - turnStartedAt - (queuedMs - queuedBefore));
    };
  }

  return {
    markFirstToken: () => { firstTokenMs ??= now() - startedAt; },
    startTurn,
    addQueuedMs: ms => { queuedMs += ms; },
    snapshot: () => ({ startedAt, ...(firstTokenMs == null ? {} : { firstTokenMs }), modelMs, queuedMs }),
  };
}
