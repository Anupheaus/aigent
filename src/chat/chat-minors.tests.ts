import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { textTurn, toolTurn } from '../testing/fake-provider.js';
import { chatSetup, delay } from './chat.test-support.js';

const SIZE = { id: 'size', text: 'Which size?', type: 'single_choice', required: true, options: [{ value: 's', label: 'Small' }, { value: 'l', label: 'Large' }], default: null, min: null, max: null };
const ASK = { id: 'ask1', name: 'ask_user', args: { questions: [SIZE] } };

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await delay(2);
}

describe('chat edge cases', () => {
  it("onStop 'discard' drops only what was waiting when stop was called, not a message sent after it", async () => {
    const { agent } = chatSetup({ turns: [textTurn('slow reply', { delayMs: 20 }), textTurn('after the stop')] });
    const chat = agent.chat({ onStop: 'discard' });
    const first = chat.send('first');
    await until(() => chat.conversation().status === 'running');
    first.stop({ mode: 'graceful' });
    const later = chat.send('sent after the stop');
    expect((await later).status).toBe('completed');
  });

  it('returns the fresh turn an answer starts, so the caller can await or stop it', async () => {
    const { agent } = chatSetup({ turns: [toolTurn([ASK]), textTurn('Large it is')] });
    const chat = agent.chat();
    const turn = chat.send('order');
    await until(() => chat.conversation().openQuestions.length === 1);
    turn.stop();
    await turn;
    const answered = chat.answer('size', 'Large');
    expect(answered.ok).toBe(true);
    expect(answered.ok && answered.turn != null ? (await answered.turn).text : undefined).toBe('Large it is');
  });

  it('a reply handle that follows the running turn applies onStop when stopped', async () => {
    const { agent } = chatSetup({ turns: [toolTurn([ASK]), textTurn('ok', { delayMs: 20 }), textTurn('never')] });
    const chat = agent.chat({ onStop: 'discard' });
    void chat.send('order');
    await until(() => chat.conversation().openQuestions.length === 1);
    const reply = chat.send('Large');
    const queued = chat.send('and socks');
    await until(() => chat.conversation().queue.length === 1);
    reply.stop({ mode: 'immediate' });
    expect((await queued).status).toBe('cancelled');
  });

  it('gives a thread rooted on a question message the question text', async () => {
    const { agent, provider } = chatSetup({ turns: [toolTurn([ASK]), textTurn('Sizes run small')] });
    const chat = agent.chat();
    const turn = chat.send('order');
    await until(() => chat.conversation().openQuestions.length === 1);
    turn.stop();
    await turn;
    const question = chat.conversation().messages.find(({ kind }) => kind === 'question')!;
    await chat.send('why do you ask?', { replyTo: question.id });
    expect(provider.requests[1]!.messages.some(({ role, text }) => role === 'assistant' && text === 'Which size?')).toBe(true);
  });

  it('refuses a second open of a stored session in the same runtime until the first is closed', async () => {
    const { agent } = chatSetup({ turns: [textTurn('ok')], store: createInMemoryStore() });
    const first = agent.chat({ sessionId: 'shared' });
    expect(() => agent.chat({ sessionId: 'shared' })).toThrow(/session 'shared' of agent 'helper' is already open/);
    await first.close();
    const again = agent.chat({ sessionId: 'shared' });
    await again.ready;
    await again.close();
  });
});
