import { createEmptyConversation } from './conversation.js';
import type { ConversationState } from './conversation.js';
import type { Patch } from './patches.js';
import { reduceConversation } from './reduce-conversation.js';

/** A framework-neutral holder of one conversation, shaped for React's `useSyncExternalStore`. */
export interface ConversationStore {
  /** The same object until a dispatch changes something. */
  getSnapshot(): ConversationState;
  /** `listener` is called after each change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Applies a patch (re-deliveries are ignored; a gap throws `invalid_input`). */
  dispatch(patch: Patch): void;
}

const EMPTY_SESSION = { sessionId: '', agentName: '' } as const;

export function createConversationStore(initial?: ConversationState): ConversationStore {
  let snapshot = initial ?? createEmptyConversation(EMPTY_SESSION);
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispatch: patch => {
      const next = reduceConversation(snapshot, patch);
      if (next === snapshot) return;
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
