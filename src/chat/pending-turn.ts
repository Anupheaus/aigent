import type { TaskUsage } from '../core/agent-types.js';
import { createAigentError } from '../core/aigent-error.js';
import type { ChatReply } from './chat-types.js';
import type { DeliveryMode, MessageAttachment, MessageDelivery, Part } from './message.js';
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
