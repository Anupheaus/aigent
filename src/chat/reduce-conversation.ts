import { createAigentError } from '../core/aigent-error.js';
import type { ConversationState } from './conversation.js';
import type { Message } from './message.js';
import type { Patch, PatchBody } from './patches.js';
import { updateMessage } from './reduce-message.js';

type Changes = Partial<ConversationState>;

function unknownMessage(params: { messageId: string; patchType: string }): Error {
  const { messageId, patchType } = params;
  return createAigentError({ code: 'invalid_input', message: `Patch '${patchType}' refers to unknown message '${messageId}'`, details: { messageId, patchType } });
}

function mapMessage(params: { state: ConversationState; messageId: string; patchType: string; change(message: Message): Message }): Message[] {
  const { state: { messages }, messageId, patchType, change } = params;
  if (!messages.some(({ id }) => id === messageId)) throw unknownMessage({ messageId, patchType });
  return messages.map(message => (message.id === messageId ? change(message) : message));
}

function addMessage(params: { state: ConversationState; patch: Patch & { type: 'message-added' } }): Changes {
  const { state, patch: { seq, message } } = params;
  if (state.messages.some(({ id }) => id === message.id)) {
    throw createAigentError({ code: 'invalid_input', message: `Patch 'message-added' repeats message id '${message.id}'`, details: { messageId: message.id } });
  }
  return { messages: [...state.messages, { ...message, seq }] };
}

function answerQuestion(params: { state: ConversationState; body: PatchBody & { type: 'question-answered' } }): Changes {
  const { state, body: { questionId, answerMessageId } } = params;
  const open = state.openQuestions.find(({ question }) => question.id === questionId);
  const openQuestions = state.openQuestions.filter(({ question }) => question.id !== questionId);
  if (open == null) return { openQuestions };
  const messages = mapMessage({
    state, messageId: open.messageId, patchType: 'question-answered',
    change: message => ({ ...message, meta: { ...message.meta, answerMessageId, ...(message.meta.questionMeta == null ? {} : { questionMeta: { ...message.meta.questionMeta, answered: true } }) } }),
  });
  return { openQuestions, messages };
}

function pin(params: { state: ConversationState; body: PatchBody & { type: 'pinned-updated' } }): Changes {
  const { state, body: { messageId, pinned } } = params;
  const messages = mapMessage({ state, messageId, patchType: 'pinned-updated', change: message => ({ ...message, pinned, ...(pinned ? { compactable: false } : {}) }) });
  const others = state.pinned.filter(id => id !== messageId);
  return { messages, pinned: pinned ? [...others, messageId] : others };
}

function upsertById<T extends { id: string }>(entries: T[], entry: T): T[] {
  return entries.some(({ id }) => id === entry.id) ? entries.map(existing => (existing.id === entry.id ? entry : existing)) : [...entries, entry];
}

/** The fields one patch changes. */
function changesOf(state: ConversationState, patch: Patch): Changes {
  switch (patch.type) {
    case 'message-added': return addMessage({ state, patch });
    case 'message-updated': {
      const { messageId, type } = patch;
      return { messages: mapMessage({ state, messageId, patchType: type, change: message => updateMessage({ message, update: patch }) }) };
    }
    case 'message-removed': return { messages: state.messages.filter(({ id }) => id !== patch.messageId), pinned: state.pinned.filter(id => id !== patch.messageId) };
    case 'message-interrupted': return { messages: mapMessage({ state, messageId: patch.messageId, patchType: patch.type, change: message => ({ ...message, state: 'cancelled', completedAt: patch.at }) }) };
    case 'thread-updated': return { threads: upsertById(state.threads, patch.thread) };
    case 'branch-created': return { branches: upsertById(state.branches, patch.branch) };
    case 'branch-selected': return { branchId: patch.branchId };
    case 'question-opened': return { openQuestions: [...state.openQuestions, patch.question] };
    case 'question-answered': return answerQuestion({ state, body: patch });
    case 'plan-updated': return { plan: patch.items };
    case 'todo-updated': return { todo: patch.items };
    case 'status-changed': return { status: patch.status };
    case 'usage-updated': return { usage: patch.usage };
    case 'activity-updated': return { activity: patch.activity };
    case 'queue-updated': return { queue: patch.queue };
    case 'title-updated': return { title: patch.title };
    case 'pinned-updated': return pin({ state, body: patch });
    case 'session-forked': return { fork: patch.fork };
  }
}

/**
 * Applies one patch. Pure: never mutates `state`. A patch at or below `state.seq` was already applied and is ignored
 * (re-delivery after a reconnect); any other `seq` than `state.seq + 1` is a gap and throws `invalid_input`.
 */
export function reduceConversation(state: ConversationState, patch: Patch): ConversationState {
  if (patch.seq <= state.seq) return state;
  if (patch.seq !== state.seq + 1) {
    throw createAigentError({
      code: 'invalid_input',
      message: `Conversation '${state.sessionId}' is at seq ${state.seq} and received patch seq ${patch.seq}; expected ${state.seq + 1} (patches were missed: resubscribe with fromSeq ${state.seq + 1})`,
      details: { sessionId: state.sessionId, seq: state.seq, patchSeq: patch.seq },
    });
  }
  return { ...state, ...changesOf(state, patch), seq: patch.seq, updatedAt: patch.at };
}
