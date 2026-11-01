import { createAigentError } from '../core/aigent-error.js';
import type { IdGenerator } from '../core/runtime-services.js';
import type { PatchLog } from './apply-patch.js';
import { branchFrom, requireBranch, requireIdle } from './branches.js';
import type { BranchReason } from './branches.js';
import type { ChatEngine } from './chat-engine-types.js';
import type { ChatThread, ChatTurn } from './chat-types.js';
import { ROOT_BRANCH_ID } from './conversation.js';
import { lineage } from './lineage.js';
import { summaryMessage } from './message-builders.js';
import { promotionText, threadMessages, threadWith } from './threads.js';
import { createTurnHandle } from './turn-handle.js';

export interface NavigationParams {
  log: PatchLog;
  engine: ChatEngine;
  ids: IdGenerator;
  now(): number;
}

function requireMessage(params: { log: PatchLog; messageId: string }): void {
  const { log, messageId } = params;
  if (!log.state().messages.some(({ id }) => id === messageId)) {
    throw createAigentError({ code: 'invalid_input', message: `Unknown message '${messageId}' in session '${log.state().sessionId}'`, details: { messageId } });
  }
}

/** Edit or regenerate: a new branch from just before the message, selected, then a turn on it. Nothing is deleted. */
export function branchAndRun(params: NavigationParams & { messageId: string; reason: BranchReason; newText?: string }): ChatTurn {
  const { log, engine, ids, now, messageId, reason, newText } = params;
  requireIdle({ state: log.state(), action: reason === 'edit' ? 'edit a message' : 'regenerate a reply' });
  const point = branchFrom({ state: log.state(), messageId, reason, branchId: ids.next('branch'), at: now() });
  log.append({ type: 'branch-created', branch: point.branch });
  log.append({ type: 'branch-selected', branchId: point.branch.id });
  const agentMessageId = ids.next('msg');
  const handle = createTurnHandle(agentMessageId);
  if (newText != null) {
    engine.accept({ agentMessageId, handle, taskText: newText, user: { id: ids.next('msg'), text: newText, modelText: newText } });
  } else {
    engine.accept({ agentMessageId, handle, taskText: point.taskText, ...(point.replyTo == null ? {} : { replyTo: point.replyTo }) });
  }
  return handle.turn;
}

export function selectBranch(params: { log: PatchLog; branchId: string }): void {
  const { log, branchId } = params;
  requireBranch({ state: log.state(), branchId });
  requireIdle({ state: log.state(), action: 'switch branches' });
  if (log.state().branchId !== branchId) log.append({ type: 'branch-selected', branchId });
}

export function setPinned(params: { log: PatchLog; messageId: string; pinned: boolean }): void {
  const { log, messageId, pinned } = params;
  requireMessage({ log, messageId });
  log.append({ type: 'pinned-updated', messageId, pinned });
}

/** A thread on a message: its replies, and promotion of a summary into the main line. */
export function threadOf(params: NavigationParams & { messageId: string }): ChatThread {
  const { log, ids, now, messageId } = params;
  requireMessage({ log, messageId });
  const rootMessageId = log.state().messages.find(({ id }) => id === messageId)?.threadId ?? messageId;
  return {
    rootMessageId,
    messages: () => threadMessages({ state: log.state(), rootMessageId }),
    promote: () => {
      const state = log.state();
      const message = summaryMessage({ id: ids.next('msg'), branchId: state.branchId, createdAt: now(), text: promotionText({ state, rootMessageId }), replyTo: rootMessageId });
      log.append({ type: 'message-added', message });
      const at = now();
      log.append({ type: 'thread-updated', thread: { ...threadWith({ state: log.state(), rootMessageId, messageIds: [], at }), promotedAt: at } });
      return log.state().messages.find(({ id }) => id === message.id) ?? message;
    },
  };
}

/** The patches a fork starts with: where it came from, then the parent's main line up to the fork point. */
export function forkSeed(params: { parent: PatchLog; atMessageId?: string }): (log: PatchLog) => void {
  const { parent, atMessageId } = params;
  const state = parent.state();
  const line = lineage({ state });
  const end = atMessageId == null ? line.length : line.findIndex(({ id }) => id === atMessageId) + 1;
  if (end === 0) throw createAigentError({ code: 'invalid_input', message: `Cannot fork session '${state.sessionId}' at '${atMessageId}': it is not on the active branch's main line`, details: { messageId: atMessageId } });
  const copied = line.slice(0, end);
  const forkPoint = copied.at(-1)?.id;
  return log => {
    log.append({ type: 'session-forked', fork: { parentSessionId: state.sessionId, ...(forkPoint == null ? {} : { forkPoint }) } });
    for (const message of copied) {
      // Same ids and content, on the fork's own root branch; a reply still streaming in the parent is cut there.
      log.append({ type: 'message-added', message: { ...message, branchId: ROOT_BRANCH_ID, state: message.state === 'streaming' ? 'cancelled' : message.state } });
      if (message.pinned) log.append({ type: 'pinned-updated', messageId: message.id, pinned: true });
    }
  };
}
