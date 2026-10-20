import { describe, expect, it } from 'vitest';
import { textTurn, toolTurn } from '../testing/fake-provider.js';
import { chatSetup, delay } from './chat.test-support.js';

const SIZE = { id: 'size', text: 'Size?', type: 'single_choice', required: true, options: [{ value: 's', label: 'Small' }, { value: 'l', label: 'Large' }], default: null, min: null, max: null };
const CLOSE_LIMIT_MS = 1_000;

function askCall(id: string) {
  return { id, name: 'ask_user', args: { questions: [SIZE] } };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await delay(2);
}

/** Resolves 'closed' when `closing` settles in time, 'hung' otherwise. */
async function settlesInTime(closing: Promise<void>): Promise<'closed' | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<'hung'>(resolve => { timer = setTimeout(() => resolve('hung'), CLOSE_LIMIT_MS); });
  const outcome = await Promise.race([closing.then(() => 'closed' as const), hung]);
  clearTimeout(timer);
  return outcome;
}

describe('chat.close()', () => {
  it('settles when the model calls ask_user after close began (the turn is stopped, its question kept open)', async () => {
    const { agent } = chatSetup({ turns: [{ ...toolTurn([askCall('ask1')]), delayMs: 20 }] });
    const chat = agent.chat();
    const turn = chat.send('order a shirt');
    await until(() => chat.conversation().status === 'running');
    const closing = chat.close();
    expect(await settlesInTime(closing)).toBe('closed');
    expect((await turn).status).toBe('cancelled');
    expect(chat.conversation().openQuestions.map(({ question }) => question.id)).toEqual(['size']);
  });

  it('does not start a queued turn after close stops the waiting one, and settles the queued message cancelled', async () => {
    const { agent, provider } = chatSetup({ turns: [toolTurn([askCall('ask1')]), toolTurn([askCall('ask2')])] });
    const chat = agent.chat();
    const first = chat.send('order a shirt');
    await until(() => chat.conversation().status === 'waiting_for_user');
    // Not a valid answer to the single-choice question, so it queues behind the waiting turn.
    const second = chat.send('and also socks');
    await until(() => chat.conversation().queue.length === 1);
    expect(await settlesInTime(chat.close())).toBe('closed');
    expect((await first).status).toBe('cancelled');
    expect((await second).status).toBe('cancelled');
    expect(provider.requests).toHaveLength(1);
    expect(chat.conversation().openQuestions).toHaveLength(1);
  });

  it('ai.close() settles a chat that asks after close began', async () => {
    const { agent, ai } = chatSetup({ turns: [{ ...toolTurn([askCall('ask1')]), delayMs: 20 }] });
    const chat = agent.chat();
    const turn = chat.send('hi');
    await until(() => chat.conversation().status === 'running');
    expect(await settlesInTime(ai.close())).toBe('closed');
    expect((await turn).status).toBe('cancelled');
  });

  it('refuses sends, answers, edits and forks once closed, writing nothing more', async () => {
    const { agent } = chatSetup({ turns: [toolTurn([askCall('ask1')]), textTurn('never')] });
    const chat = agent.chat();
    void chat.send('hi');
    await until(() => chat.conversation().status === 'waiting_for_user');
    await chat.close();
    const { seq } = chat.conversation();
    await expect(chat.send('more')).rejects.toThrow(/Chat session '.+' is closed/);
    expect(chat.answer('size', 's')).toEqual({ ok: false, error: expect.stringMatching(/is closed/) });
    const userMessage = chat.conversation().messages.find(({ role }) => role === 'user')!;
    expect(() => chat.edit(userMessage.id, 'changed')).toThrow(/is closed/);
    expect(() => chat.fork()).toThrow(/is closed/);
    expect(chat.conversation().seq).toBe(seq);
  });
});
