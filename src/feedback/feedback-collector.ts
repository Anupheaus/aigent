import type { AgentFeedbackEntry } from './feedback-records.js';

/** One `aigent_feedback` entry, waiting to be stored with its run's records. */
export interface CollectedFeedback {
  runId: string;
  callId: string;
  /** Position within its call's `entries`. */
  index: number;
  entry: AgentFeedbackEntry;
}

/** Holds each run's feedback entries until the run's records are written, so they share its redaction and queue. */
export interface FeedbackCollector {
  add(collected: CollectedFeedback): void;
  /** The run's entries in arrival order; they are removed, so a second call returns `[]`. */
  take(runId: string): CollectedFeedback[];
}

export function createFeedbackCollector(): FeedbackCollector {
  const byRun = new Map<string, CollectedFeedback[]>();
  return {
    add: collected => {
      const entries = byRun.get(collected.runId) ?? [];
      entries.push(collected);
      byRun.set(collected.runId, entries);
    },
    take: runId => {
      const entries = byRun.get(runId) ?? [];
      byRun.delete(runId);
      return entries;
    },
  };
}
