import type { IdGenerator } from '../core/runtime-services.js';
import type { ChatEngine } from './chat-engine.js';
import type { ChatTurn, SendInput, SendOptions } from './chat-types.js';
import type { PatchLog } from './apply-patch.js';
import type { DeliveryMode } from './message.js';
import type { PreparedAttachments } from './attachments.js';
import type { AttachmentInput } from './chat-types.js';
import { validateAnswer } from './question-state.js';
import { threadRootOf } from './threads.js';
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
  /** The chat's defaults: `whileBusy` and `coalesce`. */
  defaults: { delivery: DeliveryMode; coalesce: boolean };
  prepareAttachments(attachments: AttachmentInput[]): Promise<PreparedAttachments>;
}

export type Send = (input: string | SendInput, options?: SendOptions) => ChatTurn;

interface SendRequest {
  input: SendInput;
  options: SendOptions;
  handle: TurnHandle;
  userMessageId: string;
  agentMessageId: string;
}

function toSendInput(input: string | SendInput): SendInput {
  return typeof input === 'string' ? { text: input } : input;
}

/**
 * The documented rule: a plain reply (no delivery, thread or attachments) while exactly one question is open answers
 * it when it is a valid answer for that question; otherwise it is a new message.
 */
function answerByReply(params: { loaded: LoadedChat; request: SendRequest }): boolean {
  const { loaded: { engine }, request: { input: { text, attachments = [], replyTo }, options, handle } } = params;
  const open = engine.questions.singleOpen();
  if (open == null || options.delivery != null || options.replyTo != null || replyTo != null || attachments.length > 0) return false;
  if (!validateAnswer({ question: open.question, value: text }).ok) return false;
  const { freshTurn } = engine.questions.answer({ questionId: open.question.id, value: text, handle });
  // A live turn resumes with the answer: the handle follows it. Otherwise the answer started a fresh turn on this handle.
  if (freshTurn == null) engine.followActive(handle);
  return true;
}

export function createSender(params: CreateSenderParams): Send {
  const { ids, whenLoaded, track, defaults, prepareAttachments } = params;
  /** Sends whose attachments are being read; later sends wait behind them so order is kept. */
  let chain: Promise<void> = Promise.resolve();
  let preparing = 0;

  function accept(params: { loaded: LoadedChat; request: SendRequest; prepared?: PreparedAttachments }): void {
    const { loaded, request, prepared } = params;
    const { input: { text, compactable }, options, handle, userMessageId, agentMessageId } = request;
    if (prepared == null && answerByReply({ loaded, request })) return;
    const replyTo = options.replyTo ?? request.input.replyTo;
    const threadId = replyTo == null ? undefined : threadRootOf({ state: loaded.log.state(), replyTo });
    loaded.engine.accept({
      agentMessageId, handle, taskText: text, delivery: options.delivery ?? defaults.delivery, coalesce: options.coalesce ?? defaults.coalesce,
      ...(options.force === true ? { force: true } : {}), ...(replyTo == null ? {} : { replyTo }), ...(threadId == null ? {} : { threadId }),
      user: {
        id: userMessageId, text, modelText: text + (prepared?.modelText ?? ''), ...(compactable == null ? {} : { compactable }),
        ...(prepared == null || prepared.parts.length === 0 ? {} : { parts: prepared.parts, attachments: prepared.meta }),
      },
    });
  }

  function guarded(request: SendRequest, work: () => void): void {
    try {
      work();
    } catch (error) {
      // An invalid send (unknown replyTo, unreadable attachment) fails its own turn only.
      request.handle.fail(error);
    }
  }

  return (raw, options = {}) => {
    const input = toSendInput(raw);
    const agentMessageId = ids.next('msg');
    const request: SendRequest = { input, options, handle: createTurnHandle(agentMessageId), userMessageId: ids.next('msg'), agentMessageId };
    track(Promise.resolve(request.handle.turn).catch(() => undefined));
    const { attachments = [] } = input;
    if (attachments.length === 0 && preparing === 0) {
      whenLoaded(loaded => guarded(request, () => accept({ loaded, request })));
      return request.handle.turn;
    }
    preparing += 1;
    chain = chain.then(async () => {
      try {
        const prepared = attachments.length === 0 ? undefined : await prepareAttachments(attachments);
        whenLoaded(loaded => guarded(request, () => accept({ loaded, request, ...(prepared == null ? {} : { prepared }) })));
      } catch (error) {
        request.handle.fail(error);
      } finally {
        preparing -= 1;
      }
    });
    return request.handle.turn;
  };
}
