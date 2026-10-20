import type { ActivityUpdate } from '../core/activity-update.js';
import type { PlanItemState, TodoItem } from '../planning/plan-schema.js';
import type { Branch, ConversationStatus, ConversationUsage, ForkOrigin, OpenQuestion, QueuedMessage, Thread } from './conversation.js';
import type { JsonValue, Message } from './message.js';

/** Fields a `message-updated` patch may replace (identity and position never change). */
export type MessageChanges = Partial<Omit<Message, 'id' | 'seq'>>;

/** What changed; every body is plain JSON. */
export type PatchBody =
  | { type: 'message-added'; message: Message }
  /**
   * `delta` is appended to the text of part `partIndex` (default 0; a text part is created when the index is the next
   * free one); `set` then replaces the given fields.
   */
  | { type: 'message-updated'; messageId: string; partIndex?: number; delta?: string; set?: MessageChanges }
  /** UI-local cancellation only (a queued draft); history is never deleted. */
  | { type: 'message-removed'; messageId: string }
  | { type: 'thread-updated'; thread: Thread }
  | { type: 'branch-created'; branch: Branch }
  | { type: 'branch-selected'; branchId: string }
  | { type: 'question-opened'; question: OpenQuestion }
  /** `skipped`: closed unanswered (its batch completed without it); `value` is null and the question stays unanswered. */
  | { type: 'question-answered'; questionId: string; answerMessageId: string; value: JsonValue; skipped?: true }
  | { type: 'plan-updated'; items: PlanItemState[] }
  | { type: 'todo-updated'; items: TodoItem[] }
  | { type: 'status-changed'; status: ConversationStatus }
  | { type: 'usage-updated'; usage: ConversationUsage }
  | { type: 'activity-updated'; activity: ActivityUpdate }
  | { type: 'queue-updated'; queue: QueuedMessage[] }
  /** The agent message was cut short; its partial content is kept with state `cancelled`. */
  | { type: 'message-interrupted'; messageId: string; byMessageId?: string }
  | { type: 'title-updated'; title: string }
  | { type: 'pinned-updated'; messageId: string; pinned: boolean }
  /** First patch of a forked session. */
  | { type: 'session-forked'; fork: ForkOrigin };

export type PatchType = PatchBody['type'];

/** One change to a conversation: `seq` is gapless and monotonic per session, `at` is epoch ms. */
export type Patch = { seq: number; at: number } & PatchBody;
