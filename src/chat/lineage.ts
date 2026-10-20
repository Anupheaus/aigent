import { createAigentError } from '../core/aigent-error.js';
import type { ConversationState } from './conversation.js';
import type { Message } from './message.js';

/** The messages up to and including `baseMessageId`; none when it is absent. */
function cutAt(messages: Message[], baseMessageId: string | undefined): Message[] {
  if (baseMessageId == null) return [];
  const index = messages.findIndex(({ id }) => id === baseMessageId);
  return index === -1 ? messages : messages.slice(0, index + 1);
}

/**
 * The main line of a branch, as the model sees it: the parent's lineage up to the branch point, then the branch's
 * own messages. Thread replies are not part of it.
 */
export function lineage(params: { state: ConversationState; branchId?: string }): Message[] {
  const { state, branchId = state.branchId } = params;
  const branch = state.branches.find(({ id }) => id === branchId);
  if (branch == null) {
    throw createAigentError({ code: 'invalid_input', message: `Unknown branch '${branchId}' in session '${state.sessionId}'; known branches: ${state.branches.map(({ id }) => id).join(', ')}`, details: { branchId } });
  }
  const inherited = branch.parentBranchId == null ? [] : cutAt(lineage({ state, branchId: branch.parentBranchId }), branch.baseMessageId);
  const own = state.messages.filter(message => message.branchId === branchId && message.threadId == null);
  return [...inherited, ...own];
}
