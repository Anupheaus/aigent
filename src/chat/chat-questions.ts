import type { IdGenerator } from '../core/runtime-services.js';
import type { PatchLog } from './apply-patch.js';
import type { AskUser } from './ask-user-tool.js';
import type { AnswerResult } from './chat-types.js';
import type { OpenQuestion } from './conversation.js';
import type { JsonValue, Message, Question } from './message.js';
import { answerBatch, batchResults, createQuestionBatch, isBatchComplete, validateAnswer } from './question-state.js';
import type { QuestionBatch, QuestionResult } from './question-state.js';
import type { TurnHandle } from './turn-handle.js';

/** Where a turn's questions go in the conversation. */
export interface QuestionPlace {
  agentMessageId: string;
  branchId: string;
  threadId?: string;
}

export interface ChatQuestionsParams {
  log: PatchLog;
  ids: IdGenerator;
  now(): number;
  /** Status while a live turn waits, and once it resumes. */
  setStatus(status: 'running' | 'waiting_for_user'): void;
  /** A batch whose turn is gone (stopped, or the session was reopened) is complete: answer it in a fresh turn. */
  resumeInFreshTurn(params: { replyTo: string; taskText: string; handle?: TurnHandle }): TurnHandle;
}

export interface ChatQuestions {
  /** The `ask_user` handler for one turn. */
  askFor(place: QuestionPlace): AskUser;
  /** `freshTurn` is set when the answer completed a batch whose turn was gone. */
  answer(params: { questionId: string; value: JsonValue; handle?: TurnHandle }): AnswerResult & { freshTurn?: TurnHandle };
  /** The only open question, when exactly one is open. */
  singleOpen(): OpenQuestion | undefined;
}

interface Waiter {
  batch: QuestionBatch;
  resolve(results: QuestionResult[]): void;
}

function displayValue(value: JsonValue): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

function questionMessage(params: { id: string; question: Question; place: QuestionPlace; callId: string; createdAt: number }): Message {
  const { id, question, place: { agentMessageId, branchId, threadId }, callId, createdAt } = params;
  return {
    id, seq: 0, role: 'agent', kind: 'question', parts: [{ type: 'text', text: question.text }, { type: 'question', questionId: question.id }], replyTo: agentMessageId, branchId,
    state: 'complete', createdAt, completedAt: createdAt, pinned: false, compactable: false, meta: { questionMeta: { questionId: question.id, type: question.type, answered: false, callId } },
    ...(threadId == null ? {} : { threadId }),
  };
}

/** Questions asked through `ask_user`: the suspended turns waiting on them and the answers that resume them. */
export function createChatQuestions(params: ChatQuestionsParams): ChatQuestions {
  const { log, ids, now, setStatus, resumeInFreshTurn } = params;
  const waiters = new Map<string, Waiter>();

  function askFor(place: QuestionPlace): AskUser {
    return ({ questions, callId, signal }) => new Promise(resolve => {
      for (const question of questions) {
        const messageId = ids.next('msg');
        log.append({ type: 'message-added', message: questionMessage({ id: messageId, question, place, callId, createdAt: now() }) });
        log.append({ type: 'question-opened', question: { question, messageId, callId } });
      }
      waiters.set(callId, { batch: createQuestionBatch({ callId, questions }), resolve });
      // The turn is suspended inside this tool: no model request runs (and no tokens are spent) until it resolves.
      setStatus('waiting_for_user');
      signal.addEventListener('abort', () => { waiters.delete(callId); }, { once: true });
    });
  }

  function addAnswer(params: { open: OpenQuestion; value: JsonValue }): string {
    const { open: { question, messageId }, value } = params;
    const id = ids.next('msg');
    const text = displayValue(value);
    const { branchId, threadId } = log.state().messages.find(message => message.id === messageId) ?? { branchId: log.state().branchId, threadId: undefined };
    log.append({
      type: 'message-added',
      message: {
        id, seq: 0, role: 'user', kind: 'answer', parts: [{ type: 'text', text }], replyTo: messageId, branchId, state: 'complete', createdAt: now(), pinned: false, compactable: false,
        // Replayed as user text only while the model has not had it as the call's result.
        meta: { answeredQuestionId: question.id, history: [{ role: 'user', text: `Answer to your question '${question.id}' ("${question.text}"): ${text}` }] },
        ...(threadId == null ? {} : { threadId }),
      },
    });
    log.append({ type: 'question-answered', questionId: question.id, answerMessageId: id, value });
    return id;
  }

  function markDelivered(batch: QuestionBatch): void {
    const answered = new Set(Object.keys(batch.answers));
    for (const message of log.state().messages) {
      if (message.kind !== 'answer' || !answered.has(message.meta.answeredQuestionId ?? '') || message.meta.history == null) continue;
      const { history: _delivered, ...meta } = message.meta;
      log.append({ type: 'message-updated', messageId: message.id, set: { meta } });
    }
  }

  function answer(params: { questionId: string; value: JsonValue; handle?: TurnHandle }): AnswerResult & { freshTurn?: TurnHandle } {
    const { questionId, value, handle } = params;
    const open = log.state().openQuestions.find(({ question }) => question.id === questionId);
    if (open == null) return { ok: false, error: `Question '${questionId}' is not open; open questions: ${log.state().openQuestions.map(({ question }) => question.id).join(', ') || '(none)'}` };
    const check = validateAnswer({ question: open.question, value });
    if (!check.ok) return check;
    const answerMessageId = addAnswer({ open, value: check.value });
    const waiter = waiters.get(open.callId);
    if (waiter != null) {
      waiter.batch = answerBatch(waiter.batch, { questionId, value: check.value });
      if (isBatchComplete(waiter.batch)) {
        waiters.delete(open.callId);
        markDelivered(waiter.batch);
        setStatus('running');
        waiter.resolve(batchResults(waiter.batch));
      }
      return { ok: true };
    }
    const isRequiredStillOpen = log.state().openQuestions.some(({ callId, question }) => callId === open.callId && question.required);
    if (isRequiredStillOpen) return { ok: true };
    return { ok: true, freshTurn: resumeInFreshTurn({ replyTo: answerMessageId, taskText: `Answered: ${open.question.text}`, ...(handle == null ? {} : { handle }) }) };
  }

  return {
    askFor,
    answer,
    singleOpen: () => { const { openQuestions } = log.state(); return openQuestions.length === 1 ? openQuestions[0] : undefined; },
  };
}
