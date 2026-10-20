import { describe, expect, it } from 'vitest';
import { createEmptyConversation } from './conversation.js';
import type { ConversationState } from './conversation.js';
import { reduceConversation } from './reduce-conversation.js';
import type { Patch, PatchBody } from './patches.js';
import { jsonRoundTrip, SESSION, testMessage } from './chat-model.test-support.js';

function fold(bodies: PatchBody[], start: ConversationState = createEmptyConversation(SESSION)): ConversationState {
  return bodies.reduce((state, body, index) => reduceConversation(state, { ...body, seq: start.seq + index + 1, at: 100 + index } as Patch), start);
}

const ACTIVITY = { seq: 1, runId: 'r1', phase: 'thinking', statusText: 'Thinking', elapsedMs: 0, tokens: { input: 0, output: 0 }, costUsd: 0, heartbeat: false } as const;

describe('reduceConversation', () => {
  it('adds messages with the patch seq and stamps seq and updatedAt', () => {
    const state = fold([{ type: 'message-added', message: testMessage('m1') }]);
    expect(state.messages[0]).toMatchObject({ id: 'm1', seq: 1 });
    expect(state).toMatchObject({ seq: 1, updatedAt: 100 });
  });

  it('assembles streamed deltas into the final text, creating the next part on demand', () => {
    const deltas = ['Hel', 'lo ', 'world'];
    const state = fold([
      { type: 'message-added', message: testMessage('a1', { role: 'agent', parts: [], state: 'streaming' }) },
      ...deltas.map((delta): PatchBody => ({ type: 'message-updated', messageId: 'a1', delta })),
      { type: 'message-updated', messageId: 'a1', set: { state: 'complete', completedAt: 9 } },
    ]);
    expect(state.messages[0]).toMatchObject({ parts: [{ type: 'text', text: 'Hello world' }], state: 'complete', completedAt: 9 });
  });

  it('rejects a delta aimed at a part without text', () => {
    const start = fold([{ type: 'message-added', message: testMessage('m1', { parts: [{ type: 'question', questionId: 'q' }] }) }]);
    expect(() => fold([{ type: 'message-updated', messageId: 'm1', delta: 'x' }], start)).toThrow(/targets part 0, which is a 'question' part/);
  });

  it.each<[string, PatchBody, (state: ConversationState) => unknown, unknown]>([
    ['message-removed', { type: 'message-removed', messageId: 'm1' }, state => state.messages.length, 0],
    ['message-interrupted', { type: 'message-interrupted', messageId: 'm1' }, state => state.messages[0]?.state, 'cancelled'],
    ['thread-updated', { type: 'thread-updated', thread: { id: 'm1', rootMessageId: 'm1', messageIds: ['x'], updatedAt: 1 } }, state => state.threads, [{ id: 'm1', rootMessageId: 'm1', messageIds: ['x'], updatedAt: 1 }]],
    ['branch-created', { type: 'branch-created', branch: { id: 'b1', parentBranchId: 'main', baseMessageId: 'm1', reason: 'edit', createdAt: 2 } }, state => state.branches.map(({ id }) => id), ['main', 'b1']],
    ['branch-selected', { type: 'branch-selected', branchId: 'b1' }, state => state.branchId, 'b1'],
    ['question-opened', { type: 'question-opened', question: { question: { id: 'q1', text: 'Name?', type: 'text', required: true }, messageId: 'm1', callId: 'c1' } }, state => state.openQuestions.length, 1],
    ['plan-updated', { type: 'plan-updated', items: [] }, state => state.plan, []],
    ['todo-updated', { type: 'todo-updated', items: [{ id: 't1', label: 'x', status: 'pending' }] }, state => state.todo?.length, 1],
    ['status-changed', { type: 'status-changed', status: 'running' }, state => state.status, 'running'],
    ['usage-updated', { type: 'usage-updated', usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, costUsd: 0, turns: 1, toolCalls: 0, replies: 1 } }, state => state.usage.outputTokens, 2],
    ['activity-updated', { type: 'activity-updated', activity: ACTIVITY }, state => state.activity?.phase, 'thinking'],
    ['queue-updated', { type: 'queue-updated', queue: [{ id: 'q', text: 'later', queuedAt: 3 }] }, state => state.queue.length, 1],
    ['title-updated', { type: 'title-updated', title: 'Chat' }, state => state.title, 'Chat'],
    ['pinned-updated', { type: 'pinned-updated', messageId: 'm1', pinned: true }, state => [state.pinned, state.messages[0]?.pinned, state.messages[0]?.compactable], [['m1'], true, false]],
    ['session-forked', { type: 'session-forked', fork: { parentSessionId: 'p', forkPoint: 'm1' } }, state => state.fork, { parentSessionId: 'p', forkPoint: 'm1' }],
  ])('applies %s', (_name, body, select, expected) => {
    const start = fold([{ type: 'message-added', message: testMessage('m1') }]);
    expect(select(fold([body], start))).toEqual(expected);
  });

  it('closes the question and links the question message to its answer', () => {
    const state = fold([
      { type: 'message-added', message: testMessage('qm', { role: 'agent', kind: 'question', meta: { questionMeta: { questionId: 'q1', type: 'text', answered: false, callId: 'c1' } } }) },
      { type: 'question-opened', question: { question: { id: 'q1', text: 'Name?', type: 'text', required: true }, messageId: 'qm', callId: 'c1' } },
      { type: 'message-added', message: testMessage('am', { kind: 'answer', meta: { answeredQuestionId: 'q1' } }) },
      { type: 'question-answered', questionId: 'q1', answerMessageId: 'am', value: 'Ada' },
    ]);
    expect(state.openQuestions).toEqual([]);
    expect(state.messages[0]?.meta).toMatchObject({ answerMessageId: 'am', questionMeta: { answered: true } });
  });

  it('ignores re-delivered patches and throws on a gap', () => {
    const state = fold([{ type: 'message-added', message: testMessage('m1') }]);
    expect(reduceConversation(state, { seq: 1, at: 5, type: 'title-updated', title: 'again' })).toBe(state);
    expect(() => reduceConversation(state, { seq: 3, at: 5, type: 'title-updated', title: 'x' })).toThrow(/at seq 1 and received patch seq 3; expected 2/);
  });

  it('rejects unknown message ids and duplicate message ids', () => {
    const state = fold([{ type: 'message-added', message: testMessage('m1') }]);
    expect(() => fold([{ type: 'message-updated', messageId: 'nope', delta: 'x' }], state)).toThrow(/unknown message 'nope'/);
    expect(() => fold([{ type: 'message-added', message: testMessage('m1') }], state)).toThrow(/repeats message id 'm1'/);
  });

  it('never mutates its input', () => {
    const state = fold([{ type: 'message-added', message: testMessage('m1') }]);
    const frozen = structuredClone(state);
    fold([{ type: 'message-updated', messageId: 'm1', delta: 'x' }, { type: 'pinned-updated', messageId: 'm1', pinned: true }], state);
    expect(state).toEqual(frozen);
  });

  it('keeps every snapshot and patch shape plain JSON', () => {
    const bodies: PatchBody[] = [
      { type: 'message-added', message: testMessage('m1', { parts: [{ type: 'card', data: { a: [1, null, 'x'] } }, { type: 'table', columns: ['a'], rows: [['1']] }], delivery: { mode: 'queue', queuedAt: 1 } }) },
      { type: 'activity-updated', activity: { ...ACTIVITY, current: [{ tool: 'echo', callId: 'c', startedAt: 1 }] } },
    ];
    const patches = bodies.map((body, index) => ({ ...body, seq: index + 1, at: index }) as Patch);
    expect(jsonRoundTrip(patches)).toEqual(patches);
    const state = fold(bodies);
    expect(jsonRoundTrip(state)).toEqual(state);
  });
});
