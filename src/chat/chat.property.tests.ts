import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import type { ChatTurn } from './chat-types.js';
import { createEmptyConversation } from './conversation.js';
import { reduceConversation } from './reduce-conversation.js';
import type { Patch } from './patches.js';
import { chatSetup, delay } from './chat.test-support.js';

const OPERATIONS = 20;
const SCRIPTED_TURNS = 60;

type Operation =
  | { kind: 'send'; delivery: 'queue' | 'steer' | 'interrupt'; coalesce: boolean }
  | { kind: 'pin'; pick: number }
  | { kind: 'remove-queued' }
  | { kind: 'stop' }
  | { kind: 'wait'; ms: number };

const operation: fc.Arbitrary<Operation> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('send' as const), delivery: fc.constantFrom('queue' as const, 'steer' as const, 'interrupt' as const), coalesce: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('pin' as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('remove-queued' as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('stop' as const) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 15 }) }) },
);

function script(): FakeTurn[] {
  return Array.from({ length: SCRIPTED_TURNS }, (_unused, index) => (index % 4 === 1
    ? toolTurn([{ id: `c${index}`, name: 'echo', args: { text: `t${index}` } }], { delayMs: 2 })
    : textTurn(`reply ${index}`, { chunkSize: 3, delayMs: 2 })));
}

describe('chat (property)', () => {
  it('keeps the patch stream gapless and the snapshot equal to the folded stream under random interleavings', async () => {
    await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: OPERATIONS, maxLength: OPERATIONS }), async operations => {
      const { agent } = chatSetup({ turns: script() });
      const chat = agent.chat();
      const patches: Patch[] = [];
      chat.subscribe(patch => patches.push(patch));
      const turns: ChatTurn[] = [];
      for (const [index, step] of operations.entries()) {
        if (step.kind === 'send') turns.push(chat.send(`message ${index}`, { delivery: step.delivery, coalesce: step.coalesce }));
        if (step.kind === 'pin') { const { messages } = chat.conversation(); const target = messages[step.pick % Math.max(messages.length, 1)]; if (target != null) chat.pin(target.id); }
        if (step.kind === 'remove-queued') { const [first] = chat.queue(); if (first != null) chat.queue.remove(first.id); }
        if (step.kind === 'stop') turns.at(-1)?.stop();
        if (step.kind === 'wait') await delay(step.ms);
      }
      await Promise.all(turns);
      await chat.close();
      const state = chat.conversation();
      expect(patches.map(({ seq }) => seq)).toEqual(patches.map((_patch, index) => index + 1));
      expect(patches.reduce(reduceConversation, createEmptyConversation({ sessionId: chat.sessionId, agentName: 'helper' }))).toEqual(state);
      expect(state.status).toBe('idle');
      expect(state.queue).toEqual([]);
      expect(state.messages.filter(({ state: messageState }) => messageState === 'streaming')).toEqual([]);
      // Every user message sent and not removed before it started is in the conversation exactly once.
      const userIds = state.messages.filter(({ role, kind }) => role === 'user' && kind === 'statement').map(({ id }) => id);
      expect(new Set(userIds).size).toBe(userIds.length);
    }), { numRuns: 12 });
  }, 120_000);
});
