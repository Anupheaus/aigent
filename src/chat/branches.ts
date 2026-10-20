import { createAigentError } from '../core/aigent-error.js';
import type { Branch, ConversationState } from './conversation.js';
import { lineage } from './lineage.js';
import type { Message } from './message.js';

export type BranchReason = 'edit' | 'regenerate';

function invalid(message: string, details: Record<string, unknown>): Error {
  return createAigentError({ code: 'invalid_input', message, details });
}

/** The message and its position on the active branch's main line. */
function locate(params: { state: ConversationState; messageId: string }): { message: Message; line: Message[]; index: number } {
  const { state, messageId } = params;
  const line = lineage({ state });
  const index = line.findIndex(({ id }) => id === messageId);
  const message = line[index];
  if (message == null) throw invalid(`Message '${messageId}' is not on the active branch '${state.branchId}' of session '${state.sessionId}' (select its branch first)`, { messageId, branchId: state.branchId });
  return { message, line, index };
}

export interface BranchPoint {
  branch: Branch;
  /** The message the new branch's turn answers (regenerate: the one before the regenerated reply). */
  replyTo?: string;
  /** The user's words that turn answers, recorded as the run's task. */
  taskText: string;
}

function lastUserText(messages: Message[]): string {
  const user = [...messages].reverse().find(({ role }) => role === 'user');
  return user?.parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('') ?? '';
}

/**
 * A new branch from just before `messageId`: an edit replaces a user message, a regeneration replaces an agent reply.
 * The old branch is untouched and stays selectable.
 */
export function branchFrom(params: { state: ConversationState; messageId: string; reason: BranchReason; branchId: string; at: number }): BranchPoint {
  const { state, messageId, reason, branchId, at } = params;
  const { message, line, index } = locate({ state, messageId });
  const isEdit = reason === 'edit';
  if (isEdit && (message.role !== 'user' || message.kind !== 'statement')) throw invalid(`Only a user's message can be edited; '${messageId}' is a ${message.role} ${message.kind}`, { messageId });
  if (!isEdit && (message.role !== 'agent' || message.kind !== 'statement')) throw invalid(`Only an agent reply can be regenerated; '${messageId}' is a ${message.role} ${message.kind}`, { messageId });
  const before = line.slice(0, index);
  const base = before.at(-1);
  const branch: Branch = { id: branchId, parentBranchId: state.branchId, reason, createdAt: at, ...(base == null ? {} : { baseMessageId: base.id }) };
  return { branch, ...(base == null ? {} : { replyTo: base.id }), taskText: lastUserText(before) };
}

export function requireBranch(params: { state: ConversationState; branchId: string }): Branch {
  const { state, branchId } = params;
  const branch = state.branches.find(({ id }) => id === branchId);
  if (branch == null) throw invalid(`Unknown branch '${branchId}' in session '${state.sessionId}'; known branches: ${state.branches.map(({ id }) => id).join(', ')}`, { branchId });
  return branch;
}

/** History changes only between turns, so the model never sees a branch switch mid-reply. */
export function requireIdle(params: { state: ConversationState; action: string }): void {
  const { state, action } = params;
  if (state.status !== 'idle' || state.queue.length > 0) {
    throw invalid(`Cannot ${action} in session '${state.sessionId}' while the agent is busy (status '${state.status}', ${state.queue.length} queued); wait for it or stop the turn first`, { status: state.status });
  }
}
