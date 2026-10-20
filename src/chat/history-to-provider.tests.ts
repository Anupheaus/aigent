import { describe, expect, it } from 'vitest';
import type { ProviderMessage } from '../providers/provider-types.js';
import { historyToProvider, repairToolPairs } from './history-to-provider.js';
import { testMessage } from './chat-model.test-support.js';

const CALL_A = { id: 'a', name: 'read', args: {} };
const CALL_B = { id: 'b', name: 'write', args: {} };

describe('repairToolPairs', () => {
  it('gives every unanswered call a synthetic aborted result right after its round, and drops orphans and empty replies', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', toolCalls: [CALL_A, CALL_B] },
      { role: 'tool', toolCallId: 'a', text: 'A' },
      { role: 'tool', toolCallId: 'zzz', text: 'orphan' },
      { role: 'assistant', text: '' },
      { role: 'user', text: 'stop' },
    ];
    const repaired = repairToolPairs(messages);
    expect(repaired.map(({ role, toolCallId, text }) => [role, toolCallId ?? text])).toEqual([
      ['user', 'go'], ['assistant', ''], ['tool', 'a'], ['tool', 'b'], ['user', 'stop'],
    ]);
    expect(JSON.parse(repaired[3]!.text!)).toMatchObject({ id: 'b', ok: false, error: { category: 'aborted', code: 'turn_interrupted' } });
  });
});

describe('historyToProvider', () => {
  it('uses each message history, falls back to the text of a reply cut short, and carries flags and round links', () => {
    const lineage = [
      testMessage('u1', { meta: { history: [{ role: 'user', text: 'hi' }] }, pinned: true, compactable: false }),
      testMessage('a1', { role: 'agent', state: 'cancelled', parts: [{ type: 'text', text: 'partial' }] }),
      testMessage('t1', { role: 'tool', kind: 'tool_activity', parts: [] }),
      testMessage('a2', { role: 'agent', meta: { history: [{ role: 'assistant', text: '', toolCalls: [CALL_A] }, { role: 'tool', toolCallId: 'a', text: 'A' }, { role: 'assistant', text: 'done' }] } }),
      testMessage('ans', { kind: 'answer', compactable: false, meta: { history: [{ role: 'user', text: 'Answer: 3' }] } }),
    ];
    const context = historyToProvider(lineage);
    expect(context.map(({ kind, message: { role }, pairId, flags }) => [kind, role, pairId, flags])).toEqual([
      ['user', 'user', undefined, { compactable: false, pinned: true }],
      ['assistant', 'assistant', undefined, { compactable: true, pinned: false }],
      ['assistant', 'assistant', 'a', { compactable: true, pinned: false }],
      ['tool', 'tool', 'a', { compactable: true, pinned: false }],
      ['assistant', 'assistant', undefined, { compactable: true, pinned: false }],
      ['answer', 'user', undefined, { compactable: false, pinned: false }],
    ]);
    expect(context[1]?.message.text).toBe('partial');
  });
});
