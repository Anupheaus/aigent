// Test-only: an independent, imperative conversation builder the reducer is checked against. Never exported.
import type { ConversationState } from './conversation.js';
import type { Message } from './message.js';
import type { Patch } from './patches.js';

function find(state: ConversationState, messageId: string): Message {
  const message = state.messages.find(({ id }) => id === messageId);
  if (message == null) throw new Error(`reference builder: no message ${messageId}`);
  return message;
}

function applyDelta(message: Message, partIndex: number, delta: string): void {
  const part = message.parts[partIndex];
  if (part == null) { message.parts.push({ type: 'text', text: delta }); return; }
  if ('text' in part) part.text += delta;
}

function applyOne(state: ConversationState, patch: Patch): void {
  switch (patch.type) {
    case 'message-added': state.messages.push({ ...structuredClone(patch.message), seq: patch.seq }); break;
    case 'message-updated': {
      const message = find(state, patch.messageId);
      if (patch.delta != null) applyDelta(message, patch.partIndex ?? 0, patch.delta);
      Object.assign(message, structuredClone(patch.set ?? {}));
      break;
    }
    case 'message-removed':
      state.messages = state.messages.filter(({ id }) => id !== patch.messageId);
      state.pinned = state.pinned.filter(id => id !== patch.messageId);
      break;
    case 'message-interrupted': Object.assign(find(state, patch.messageId), { state: 'cancelled', completedAt: patch.at }); break;
    case 'pinned-updated': {
      const message = find(state, patch.messageId);
      message.pinned = patch.pinned;
      if (patch.pinned) message.compactable = false;
      state.pinned = [...state.pinned.filter(id => id !== patch.messageId), ...(patch.pinned ? [patch.messageId] : [])];
      break;
    }
    case 'status-changed': state.status = patch.status; break;
    case 'title-updated': state.title = patch.title; break;
    case 'queue-updated': state.queue = structuredClone(patch.queue); break;
    case 'branch-created': state.branches.push(structuredClone(patch.branch)); break;
    case 'branch-selected': state.branchId = patch.branchId; break;
    default: throw new Error(`reference builder does not model ${patch.type}`);
  }
}

/** Builds the snapshot by mutating a copy of `base`, patch by patch. */
export function referenceBuild(base: ConversationState, patches: Patch[]): ConversationState {
  const state = structuredClone(base);
  for (const patch of patches) {
    applyOne(state, patch);
    state.seq = patch.seq;
    state.updatedAt = patch.at;
  }
  return state;
}
