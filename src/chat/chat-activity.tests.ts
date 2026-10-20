import { describe, expect, it } from 'vitest';
import type { ActivityUpdate } from '../core/activity-update.js';
import type { AigentEvent } from '../core/aigent-events.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { chatSetup, collect } from './chat.test-support.js';

function script(): FakeTurn[] {
  return [toolTurn([{ id: 'c1', name: 'echo', args: { text: 'x' } }]), textTurn('Done.')];
}

function activityShape(events: AigentEvent[]): unknown[] {
  return events.flatMap(event => (event.type === 'activity' ? [{ seq: event.update.seq, phase: event.update.phase, statusText: event.update.statusText, keys: Object.keys(event.update).filter(key => key !== 'messageId').sort() }] : []));
}

describe('chat activity', () => {
  it('has the same shape and order as a task run with the same script, and makes no extra provider call', async () => {
    const forTask = chatSetup({ turns: script(), runtime: { activity: { throttleMs: 0 } } });
    const taskEvents = await collect(forTask.agent.task({ task: 'echo x' }));
    const forChat = chatSetup({ turns: script(), runtime: { activity: { throttleMs: 0 } } });
    const chat = forChat.agent.chat();
    const turn = chat.send('echo x');
    const chatEvents = await collect(turn);
    await turn;
    expect(forChat.provider.requests).toHaveLength(2);
    expect(activityShape(chatEvents)).toEqual(activityShape(taskEvents));
    const updates = chatEvents.flatMap(event => (event.type === 'activity' ? [event.update] : []));
    expect(updates.every(({ messageId }) => messageId === turn.messageId)).toBe(true);
    // Mirrored into the conversation: the last activity patch is the terminal update.
    expect(chat.conversation().activity).toEqual(updates.at(-1));
    expect(updates.at(-1)?.phase).toBe('done');
  });

  it('mirrors the turn events in its callbacks', async () => {
    const { agent } = chatSetup({ turns: script(), runtime: { activity: { throttleMs: 0 } } });
    const chat = agent.chat();
    const turn = chat.send('echo x');
    const seen: ActivityUpdate[] = [];
    turn.onActivity(update => seen.push(update));
    const events = await collect(turn);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(seen).toEqual(events.flatMap(event => (event.type === 'activity' ? [event.update] : [])));
  });
});

describe('chat concurrency and close', () => {
  it('queues a message sent while the agent is busy and answers it next, in order', async () => {
    const { agent, provider } = chatSetup({ turns: [textTurn('first reply', { delayMs: 10 }), textTurn('second reply')] });
    const chat = agent.chat();
    const first = chat.send('one');
    const second = chat.send('two');
    expect(chat.conversation().queue.map(({ text }) => text)).toEqual(['two']);
    expect((await first).text).toBe('first reply');
    expect((await second).text).toBe('second reply');
    const { messages, queue } = chat.conversation();
    expect(queue).toEqual([]);
    expect(messages.map(({ role }) => role)).toEqual(['user', 'agent', 'user', 'agent']);
    expect(messages[2]?.delivery).toMatchObject({ mode: 'queue', queuedAt: expect.any(Number), startedAt: expect.any(Number) });
    expect(provider.requests[1]!.messages.some(({ text }) => text === 'first reply')).toBe(true);
  });

  it('close() waits for the running turn and flushes every write', async () => {
    const store = createInMemoryStore();
    const { agent } = chatSetup({ turns: [textTurn('slow', { delayMs: 5 })], store });
    const chat = agent.chat({ sessionId: 's-close' });
    void chat.send('hi');
    await chat.close();
    const reopened = agent.chat({ sessionId: 's-close' });
    await reopened.ready;
    expect(reopened.conversation()).toEqual(chat.conversation());
    expect(reopened.conversation().messages.at(-1)).toMatchObject({ state: 'complete' });
  });

  it('runs 30 concurrent chats of one agent without losing or mixing a message', async () => {
    const SESSIONS = 30;
    const store = createInMemoryStore();
    const turns = Array.from({ length: SESSIONS * 2 }, (_unused, index) => textTurn(`reply ${index}`, { chunkSize: 2, delayMs: 1 }));
    const { agent, ai } = chatSetup({ turns, store });
    const chats = Array.from({ length: SESSIONS }, (_unused, index) => agent.chat({ sessionId: `c${index}` }));
    await Promise.all(chats.map(async (chat, index) => { await chat.send(`hello ${index}`); await chat.send(`again ${index}`); }));
    await ai.close();
    for (const [index, chat] of chats.entries()) {
      const { messages } = chat.conversation();
      expect(messages.filter(({ role }) => role === 'user').map(({ parts }) => parts[0])).toEqual([{ type: 'text', text: `hello ${index}` }, { type: 'text', text: `again ${index}` }]);
      expect(messages.filter(({ role, state }) => role === 'agent' && state === 'complete')).toHaveLength(2);
      const reopened = agent.chat({ sessionId: `c${index}` });
      await reopened.ready;
      expect(reopened.conversation()).toEqual(chat.conversation());
    }
  });
});
