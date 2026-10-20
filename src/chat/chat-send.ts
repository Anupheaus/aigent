import type { IdGenerator } from '../core/runtime-services.js';
import type { ChatEngine } from './chat-engine.js';
import type { ChatTurn, SendInput, SendOptions } from './chat-types.js';
import type { PatchLog } from './apply-patch.js';
import { validateAnswer } from './question-state.js';
import { createTurnHandle } from './turn-handle.js';
import type { TurnHandle } from './turn-handle.js';

/** A loaded session's log and engine. */
export interface LoadedChat {
  log: PatchLog;
  engine: ChatEngine;
}

export interface CreateSenderParams {
  ids: IdGenerator;
  /** Runs `work` now when the session is loaded, else once it is (in call order). */
  whenLoaded(work: (loaded: LoadedChat) => void): void;
  track(work: Promise<unknown>): void;
}

export type Send = (input: string | SendInput, options?: SendOptions) => ChatTurn;

function toSendInput(input: string | SendInput): SendInput {
  return typeof input === 'string' ? { text: input } : input;
}

/**
 * The documented rule: a plain reply (no delivery, thread or attachments) while exactly one question is open answers
 * it when it is a valid answer for that question; otherwise it is a new message.
 */
function answerByReply(params: { loaded: LoadedChat; input: SendInput; options: SendOptions; handle: TurnHandle }): boolean {
  const { loaded: { engine }, input: { text, attachments = [], replyTo }, options, handle } = params;
  const open = engine.questions.singleOpen();
  if (open == null || options.delivery != null || options.replyTo != null || replyTo != null || attachments.length > 0) return false;
  if (!validateAnswer({ question: open.question, value: text }).ok) return false;
  const { freshTurn } = engine.questions.answer({ questionId: open.question.id, value: text, handle });
  // A live turn resumes with the answer: the handle follows it. Otherwise the answer started a fresh turn on this handle.
  if (freshTurn == null) engine.followActive(handle);
  return true;
}

export function createSender(params: CreateSenderParams): Send {
  const { ids, whenLoaded, track } = params;
  return (raw, options = {}) => {
    const input = toSendInput(raw);
    const { text, compactable } = input;
    const agentMessageId = ids.next('msg');
    const userMessageId = ids.next('msg');
    const handle = createTurnHandle(agentMessageId);
    track(Promise.resolve(handle.turn).catch(() => undefined));
    whenLoaded(loaded => {
      if (answerByReply({ loaded, input, options, handle })) return;
      loaded.engine.accept({ agentMessageId, handle, taskText: text, user: { id: userMessageId, text, modelText: text, ...(compactable == null ? {} : { compactable }) } });
    });
    return handle.turn;
  };
}
