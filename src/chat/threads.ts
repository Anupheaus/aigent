import { createAigentError } from '../core/aigent-error.js';
import type { NewContextMessage } from '../core/run-context.js';
import type { ConversationState, Thread } from './conversation.js';
import { historyToProvider } from './history-to-provider.js';
import { lineage } from './lineage.js';
import { messageText } from './message.js';
import type { Message } from './message.js';

/** Main-line messages summarised into a thread's context. */
export const THREAD_SUMMARY_MESSAGES = 6;
/** Characters kept of each summarised message. */
const SUMMARY_TEXT_LENGTH = 200;
const SUMMARISED_KINDS: ReadonlySet<string> = new Set(['statement', 'answer', 'summary']);

function findMessage(params: { state: ConversationState; messageId: string }): Message {
  const { state, messageId } = params;
  const message = state.messages.find(({ id }) => id === messageId);
  if (message == null) throw createAigentError({ code: 'invalid_input', message: `Unknown message '${messageId}' in session '${state.sessionId}'`, details: { messageId } });
  return message;
}

/** A reply to a message in a thread continues that thread; a reply to any other message opens one on it. */
export function threadRootOf(params: { state: ConversationState; replyTo: string }): string {
  const { state, replyTo } = params;
  const message = findMessage({ state, messageId: replyTo });
  return message.threadId ?? message.id;
}

function excerpt(message: Message): string | undefined {
  const text = messageText(message).replace(/\s+/g, ' ').trim();
  if (text === '' || !SUMMARISED_KINDS.has(message.kind)) return undefined;
  const clipped = text.length > SUMMARY_TEXT_LENGTH ? `${text.slice(0, SUMMARY_TEXT_LENGTH)}...` : text;
  return `- ${message.role}: ${clipped}`;
}

/** A deterministic extract of the main line's last messages (no model call). */
export function mainSummary(params: { state: ConversationState; rootMessageId: string }): string {
  const { state, rootMessageId } = params;
  const lines = lineage({ state }).filter(({ id }) => id !== rootMessageId).flatMap(message => excerpt(message) ?? []).slice(-THREAD_SUMMARY_MESSAGES);
  return `# Thread context\nThis is a side thread. The main conversation so far, in short:\n${lines.length === 0 ? '(nothing yet)' : lines.join('\n')}`;
}

/** The thread's messages in order (user replies and agent answers). */
export function threadMessages(params: { state: ConversationState; rootMessageId: string }): Message[] {
  const { state, rootMessageId } = params;
  return state.messages.filter(({ threadId }) => threadId === rootMessageId);
}

/** What a thread turn sends: a short main-line summary, the root message, then the thread's replies. */
export function threadContext(params: { state: ConversationState; rootMessageId: string }): NewContextMessage[] {
  const { state, rootMessageId } = params;
  const root = findMessage({ state, messageId: rootMessageId });
  const summary: NewContextMessage = { kind: 'user', flags: { compactable: false }, message: { role: 'user', text: mainSummary({ state, rootMessageId }) } };
  const replies = threadMessages({ state, rootMessageId });
  const rootHistory = historyToProvider([root]);
  if (rootHistory.length > 0) return [summary, ...historyToProvider([root, ...replies])];
  // A root the model never sees as history (a question, a tool row): its text, so the thread knows what it is about.
  const role = root.role === 'agent' ? 'assistant' : 'user';
  const rootText: NewContextMessage = { kind: role, flags: { compactable: false }, message: { role, text: messageText(root) } };
  return [summary, rootText, ...historyToProvider(replies)];
}

/** The thread record after `messageIds` joined it. */
export function threadWith(params: { state: ConversationState; rootMessageId: string; messageIds: string[]; at: number }): Thread {
  const { state, rootMessageId, messageIds, at } = params;
  const current = state.threads.find(({ id }) => id === rootMessageId);
  return { id: rootMessageId, rootMessageId, messageIds: [...(current?.messageIds ?? []), ...messageIds], updatedAt: at, ...(current?.promotedAt == null ? {} : { promotedAt: current.promotedAt }) };
}

/** The summary a promoted thread adds to the main line. */
export function promotionText(params: { state: ConversationState; rootMessageId: string }): string {
  const { state, rootMessageId } = params;
  const root = findMessage({ state, messageId: rootMessageId });
  const lines = threadMessages({ state, rootMessageId }).flatMap(message => excerpt(message) ?? []);
  return `[Thread summary] On "${excerpt(root)?.replace(/^- \w+: /, '') ?? rootMessageId}":\n${lines.length === 0 ? '(no replies)' : lines.join('\n')}`;
}
