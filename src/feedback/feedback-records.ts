import type { RecordMeta } from '../telemetry/run-record.js';

/** Stored agent and user feedback, keyed `${runId}:${callId}:${index}` (agent) or by response id (user). */
export const FEEDBACK_COLLECTION = 'feedback';
/** One entry per stored run, keyed by response id, so user feedback can find its run. */
export const RESPONSES_COLLECTION = 'responses';

/** A user's verdict on a response. */
export const USER_RATINGS = ['correct', 'incorrect', 'partial'] as const;

export type UserRating = typeof USER_RATINGS[number];

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

/** An `aigent_feedback` entry as stored: with content capture off, its text is replaced by its length. */
export interface StoredAgentFeedbackEntry {
  kind: AgentFeedbackKind;
  /** Only when content capture is on (models often quote task or file content here). */
  text?: string;
  /** Characters of the text when content capture is off. */
  textLength?: number;
  relatedTool?: string;
}

/** One stored `aigent_feedback` entry. */
export interface AgentFeedbackRecord extends RecordMeta {
  kind: 'agent';
  callId: string;
  index: number;
  entry: StoredAgentFeedbackEntry;
}

/** Finds a run from its response id (`responses/<responseId>`). */
export interface ResponseIndexRecord extends RecordMeta {
  responseId: string;
}

/** What a user (or the consumer on their behalf) says about a response. */
export interface UserFeedback {
  /** From `TaskResult.responseId` or the `done` event. */
  responseId: string;
  rating: UserRating;
  /** Up to 2,000 characters. */
  comment?: string;
  /** The answer that would have been right; up to 10,000 characters. */
  expectedAnswer?: string;
}

/** One rating in a response's history. */
export interface UserFeedbackHistoryEntry {
  /** Epoch ms when it was given. */
  at: number;
  rating: UserRating;
  /** Only when content capture is on. */
  comment?: string;
  /** Characters of the comment when content capture is off (the text itself is not stored). */
  commentLength?: number;
}

/** The stored user feedback on a response, keyed by response id; the latest rating wins and every rating is kept in `history`. */
export interface UserFeedbackRecord extends RecordMeta {
  kind: 'user';
  responseId: string;
  rating: UserRating;
  /** Only when content capture is on. */
  comment?: string;
  /** Characters of the comment when content capture is off. */
  commentLength?: number;
  /** Only when content capture is on. */
  expectedAnswer?: string;
  /** Characters of the expected answer when content capture is off. */
  expectedAnswerLength?: number;
  /** Every rating given, oldest first (the current one last). */
  history: UserFeedbackHistoryEntry[];
}
