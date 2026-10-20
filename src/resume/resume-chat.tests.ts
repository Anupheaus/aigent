import { describe, expect, it } from 'vitest';
import { chatSetup, delay } from '../chat/chat.test-support.js';
import { PATCHES_PER_CHUNK } from '../chat/session-persistence.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { textTurn, toolTurn } from '../testing/fake-provider.js';
import { countingStore } from './checkpoint.test-support.js';

const NAME = { id: 'name', text: 'Your name?', type: 'text', required: true, options: null, default: null, min: null, max: null };
const RESUME = { resume: { lease: { ttlMs: 60_000 } } };

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) await delay(2);
}

describe('chat resume', () => {
  it('resumes a turn suspended in ask_user after a restart: the model gets the answers as the call result', async () => {
    const store = createInMemoryStore();
    const first = chatSetup({ turns: [toolTurn([{ id: 'ask1', name: 'ask_user', args: { questions: [NAME] } }])], store, runtime: RESUME, agent: { instanceId: 'helper-1' } });
    const chat = first.agent.chat({ sessionId: 's-1' });
    void chat.send('hi');
    await until(() => chat.conversation().openQuestions.length === 1);
    await first.ai.close();

    // A later process: its clock is past the first one's (released) lease, and its ids are its own.
    let laterIds = 0;
    const second = chatSetup({ turns: [textTurn('Welcome back, Ada')], store, runtime: { ...RESUME, clock: { now: () => 10_000_000 }, ids: { next: prefix => `${prefix}_later_${(laterIds += 1)}` } }, agent: { instanceId: 'helper-1' } });
    const reopened = second.agent.chat({ sessionId: 's-1' });
    await reopened.ready;
    expect(reopened.conversation().openQuestions.map(({ question }) => question.id)).toEqual(['name']);
    expect(reopened.answer('name', 'Ada')).toEqual({ ok: true, turn: expect.anything() });
    await until(() => reopened.conversation().messages.at(-1)?.state === 'complete' && reopened.conversation().status === 'idle');
    await reopened.close();
    const [request] = second.provider.requests;
    // The same suspended model turn continues: its ask_user call now has the answers, and no extra user message was invented.
    const result = request?.messages.find(({ toolCallId }) => toolCallId === 'ask1');
    expect(JSON.parse(result?.text ?? '{}')).toMatchObject({ ok: true, result: [{ id: 'name', ok: true, value: 'Ada' }] });
    expect(request?.messages.filter(({ role, text }) => role === 'user' && text?.startsWith('Answered:') === true)).toEqual([]);
    expect(reopened.conversation().messages.at(-1)).toMatchObject({ role: 'agent', state: 'complete', parts: [{ type: 'text', text: 'Welcome back, Ada' }] });
    await second.ai.close();
  });

  it('reopens a long session from its latest snapshot and the patches after it, not the whole log', async () => {
    const counted = countingStore();
    const turns = Array.from({ length: 40 }, (_unused, index) => textTurn(`reply ${index}`));
    const { agent, ai } = chatSetup({ turns, store: counted.store });
    const chat = agent.chat({ sessionId: 's-long' });
    for (let index = 0; index < 40; index += 1) await chat.send(`message ${index}`);
    await chat.close();
    const seq = chat.conversation().seq;
    expect(seq).toBeGreaterThan(3 * PATCHES_PER_CHUNK);
    const before = counted.reads();
    const reopened = agent.chat({ sessionId: 's-long' });
    await reopened.ready;
    expect(reopened.conversation()).toEqual(chat.conversation());
    // The session record, the chunk holding the tail after the snapshot, and the read that finds no further chunk.
    expect(counted.reads() - before).toBeLessThanOrEqual(3);
    await ai.close();
  });
});
