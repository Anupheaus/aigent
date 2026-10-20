import type { ActivityUpdate } from '../core/activity-update.js';
import type { PlanItemState, TodoItem } from '../planning/plan-schema.js';
import type { Message, Question } from './message.js';

/** The branch every session starts on. */
export const ROOT_BRANCH_ID = 'main';

export type ConversationStatus = 'idle' | 'running' | 'waiting_for_user';

/** Replies to one message, kept out of the main line. */
export interface Thread {
  /** The root message's id. */
  id: string;
  rootMessageId: string;
  /** Thread replies in order (user and agent). */
  messageIds: string[];
  updatedAt: number;
  /** Epoch ms when it was summarised into the main line. */
  promotedAt?: number;
}

/** One line of the conversation; edits and regenerations start new ones, nothing is ever deleted. */
export interface Branch {
  id: string;
  parentBranchId?: string;
  /** The last message inherited from the parent's lineage; absent means none (the branch starts empty). */
  baseMessageId?: string;
  reason: 'root' | 'edit' | 'regenerate';
  createdAt: number;
}

/** A question waiting for an answer. */
export interface OpenQuestion {
  question: Question;
  /** The question message. */
  messageId: string;
  /** The `ask_user` call that asked it (one batch). */
  callId: string;
}

/** A user message waiting for the agent to finish. */
export interface QueuedMessage {
  id: string;
  text: string;
  queuedAt: number;
  replyTo?: string;
  /** Merge with the adjacent queued messages into one turn. */
  coalesce?: boolean;
}

/** Usage over every turn of the session. */
export interface ConversationUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Sum of priced turns; 0 without pricing. */
  costUsd: number;
  /** Model requests. */
  turns: number;
  toolCalls: number;
  /** Agent replies (turn groups). */
  replies: number;
  /** `autoTitle` calls, counted apart from the conversation's own usage. */
  title?: { inputTokens: number; outputTokens: number };
}

/** Where a forked session came from. */
export interface ForkOrigin {
  parentSessionId: string;
  /** The last message copied from the parent. */
  forkPoint?: string;
}

/** The whole UI-ready conversation, plain JSON; equal to folding its patch stream from the empty state. */
export interface ConversationState {
  sessionId: string;
  agentName: string;
  title?: string;
  /** The active branch: the model sees its lineage only. */
  branchId: string;
  status: ConversationStatus;
  messages: Message[];
  threads: Thread[];
  branches: Branch[];
  /** Pinned message ids, in pin order. */
  pinned: string[];
  openQuestions: OpenQuestion[];
  queue: QueuedMessage[];
  plan?: PlanItemState[];
  todo?: TodoItem[];
  activity?: ActivityUpdate;
  usage: ConversationUsage;
  fork?: ForkOrigin;
  updatedAt: number;
  /** Seq of the last applied patch (0 when none). */
  seq: number;
}

export interface EmptyConversationParams {
  sessionId: string;
  agentName: string;
}

export function emptyUsage(): ConversationUsage {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, turns: 0, toolCalls: 0, replies: 0 };
}

/** The state every patch stream starts from. */
export function createEmptyConversation(params: EmptyConversationParams): ConversationState {
  const { sessionId, agentName } = params;
  return {
    sessionId, agentName, branchId: ROOT_BRANCH_ID, status: 'idle', messages: [], threads: [], branches: [{ id: ROOT_BRANCH_ID, reason: 'root', createdAt: 0 }], pinned: [], openQuestions: [], queue: [],
    usage: emptyUsage(), updatedAt: 0, seq: 0,
  };
}
