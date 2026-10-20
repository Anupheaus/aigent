import { describe, expect, it, vi } from 'vitest';
import { createConversationStore } from './conversation-store.js';
import { createEmptyConversation } from './conversation.js';
import { SESSION } from './chat-model.test-support.js';

describe('createConversationStore', () => {
  it('keeps the snapshot reference stable between dispatches and notifies subscribers on change', () => {
    const store = createConversationStore(createEmptyConversation(SESSION));
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.dispatch({ seq: 1, at: 5, type: 'title-updated', title: 'Hello' });
    expect(listener).toHaveBeenCalledTimes(1);
    const second = store.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.title).toBe('Hello');
    // A re-delivered patch changes nothing and notifies nobody.
    store.dispatch({ seq: 1, at: 5, type: 'title-updated', title: 'Hello' });
    expect(store.getSnapshot()).toBe(second);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.dispatch({ seq: 2, at: 6, type: 'title-updated', title: 'Bye' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('starts from an empty conversation when given none and throws on a gap', () => {
    const store = createConversationStore();
    expect(store.getSnapshot()).toMatchObject({ seq: 0, messages: [] });
    expect(() => store.dispatch({ seq: 2, at: 1, type: 'title-updated', title: 'x' })).toThrow(/expected 1/);
  });
});
