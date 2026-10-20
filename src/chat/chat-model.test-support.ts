// Test-only builders for conversation messages and patches. Excluded from the build and never exported.
import { ROOT_BRANCH_ID } from './conversation.js';
import type { Message } from './message.js';

export const SESSION = { sessionId: 's1', agentName: 'helper' } as const;

export function testMessage(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id, seq: 0, role: 'user', kind: 'statement', parts: [{ type: 'text', text: '' }], branchId: ROOT_BRANCH_ID, state: 'complete', createdAt: 1, pinned: false, compactable: true, meta: {},
    ...overrides,
  };
}

/** A JSON round trip: plain data comes back deep-equal. */
export function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
