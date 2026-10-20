import type { TaskUsage } from '../core/agent-types.js';
import { createAigentError } from '../core/aigent-error.js';
import type { ChatReply } from './chat-types.js';
import type { DeliveryMode, MessageAttachment, MessageDelivery, Part } from './message.js';
import type { RunRestore } from '../resume/prepare-run-resume.js';
import { editQueued } from './message-queue.js';
import type { TurnHandle } from './turn-handle.js';

/** The user's message a turn answers, added when the turn starts. */
export interface PendingUserMessage {
  id: string;
  text: string;
  /** What the model is sent for it (attachments inlined or summarised). */
  modelText: string;
  compactable?: boolean;
  /** Attachment parts after the text. */
  parts?: Part[];
  attachments?: MessageAttachment[];
}

/** A turn on its way: with a user message (a send), or answering what is already there (regenerate, answered questions). */
export interface PendingTurn {
  agentMessageId: string;
  handle: TurnHandle;
  user?: PendingUserMessage;
  /** Without `user`: the message being answered. */
  replyTo?: string;
  /** A thread turn: the thread's root message. */
  threadId?: string;
  taskText: string;
  delivery?: DeliveryMode;
  /** `interrupt`: also abort tools with side effects. */
  force?: boolean;
  coalesce?: boolean;
  queuedAt?: number;
  /** It cut the previous reply short. */
  interrupted?: boolean;
  /** Continues a turn suspended before a restart (from its checkpoint) instead of starting a new one. */
  restore?: RunRestore;
}

/** What follows a queued message's own text in the model's view (its attachments), kept across an edit. */
function modelSuffix(params: { queue: PendingTurn[]; id: string }): string {
  const user = params.queue.find(entry => entry.user?.id === params.id)?.user;
  return user == null ? '' : user.modelText.slice(user.text.length);
}

/** Replaces a queued message's text: what is shown, what the turn records as its task, and what the model is sent. */
export function editPendingText(params: { queue: PendingTurn[]; id: string; text: string; startedIds: ReadonlySet<string> }): PendingTurn[] {
  const { queue, id, text } = params;
  return editQueued(params).map(entry => (entry.user?.id === id ? { ...entry, taskText: text, user: { ...entry.user, modelText: text + modelSuffix({ queue, id }) } } : entry));
}

const ZERO_USAGE: TaskUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, turns: 0, toolCalls: 0, toolCallsPerTurn: 0, retries: 0, fallbacks: 0, durationMs: 0 };

/** Settles a turn that never started (removed from the queue, stopped early, discarded by `onStop`). */
export function settleCancelled(pending: PendingTurn): void {
  const { handle, agentMessageId } = pending;
  const reply = { text: '', responseId: '', messageId: agentMessageId, usage: ZERO_USAGE, status: 'cancelled' as const };
  const feedback: ChatReply['feedback'] = async () => {
    throw createAigentError({ code: 'invalid_input', message: `Message '${agentMessageId}' was cancelled before the agent replied, so there is nothing to rate`, details: { messageId: agentMessageId } });
  };
  handle.settle(Object.defineProperty(reply, 'feedback', { value: feedback, enumerable: false }) as ChatReply);
}

/** How the user message reached the agent, as its meta records it. */
export function deliveryMeta(params: { pending: PendingTurn; startedAt: number }): MessageDelivery | undefined {
  const { pending: { delivery, queuedAt, interrupted }, startedAt } = params;
  if (queuedAt == null && delivery !== 'interrupt') return undefined;
  return {
    mode: delivery ?? 'queue', startedAt,
    ...(queuedAt == null ? {} : { queuedAt }),
    ...(delivery === 'interrupt' ? { interrupted: interrupted === true } : {}),
  };
}
