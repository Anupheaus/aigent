import type { RecordMeta } from '../telemetry/run-record.js';

/** Stored agent and user feedback, keyed `${runId}:${callId}:${index}` (agent) or by response id (user). */
export const FEEDBACK_COLLECTION = 'feedback';

/** What the agent reports through `aigent_feedback`. */
export const AGENT_FEEDBACK_KINDS = ['easy', 'hard', 'suggestion', 'missing', 'simplify'] as const;

export type AgentFeedbackKind = typeof AGENT_FEEDBACK_KINDS[number];

/** One entry of an `aigent_feedback` call. */
export interface AgentFeedbackEntry {
  kind: AgentFeedbackKind;
  /** 1 to 500 characters. */
  text: string;
  /** The tool the entry is about, when it is about one. */
  relatedTool?: string;
}

/** One stored `aigent_feedback` entry. */
export interface AgentFeedbackRecord extends RecordMeta {
  kind: 'agent';
  callId: string;
  index: number;
  entry: AgentFeedbackEntry;
}
