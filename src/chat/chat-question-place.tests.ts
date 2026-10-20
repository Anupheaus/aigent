import { describe, expect, it } from 'vitest';
import { textTurn, toolTurn } from '../testing/fake-provider.js';
import { chatSetup, delay } from './chat.test-support.js';

const NAME = { id: 'name', text: 'Your name?', type: 'text', required: true, options: null, default: null, min: null, max: null };
const ASK = { id: 'ask1', name: 'ask_user', args: { questions: [NAME] } };
/** The trailing request message of every turn (the volatile block), not part of the conversation. */
const VOLATILE_HEADING = '# Current state';
const ANSWER_TEXT = 'Answer to your question \'name\' ("Your name?"): Ada';

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await delay(2);
}

describe('answering a question whose turn is gone', () => {
  it('resumes a thread question in that thread, where the model sees the answer', async () => {
    const { agent, provider } = chatSetup({ turns: [textTurn('main reply'), toolTurn([ASK]), textTurn('Thanks, Ada')] });
    const chat = agent.chat();
    const main = await chat.send('main msg');
    const threadTurn = chat.send('side question', { replyTo: main.messageId });
    await until(() => chat.conversation().openQuestions.length === 1);
    threadTurn.stop();
    await threadTurn;
    expect(chat.answer('name', 'Ada')).toMatchObject({ ok: true });
    await chat.close();
    const request = provider.requests[2]!;
    expect(request.messages.some(({ text }) => text === ANSWER_TEXT)).toBe(true);
    // The model's last real turn is the user's answer, not the main line's earlier reply.
    expect(request.messages.filter(({ role, text }) => role !== 'system' && text?.startsWith(VOLATILE_HEADING) !== true).at(-1)).toMatchObject({ role: 'user' });
    const reply = chat.conversation().messages.at(-1)!;
    expect(reply).toMatchObject({ role: 'agent', threadId: main.messageId, parts: [{ type: 'text', text: 'Thanks, Ada' }] });
  });

  it('keeps a question of an unselected branch out of plain replies and refuses answering it there', async () => {
    const { agent, provider } = chatSetup({ turns: [toolTurn([ASK]), textTurn('edited reply'), textTurn('unrelated reply')] });
    const chat = agent.chat();
    const turn = chat.send('first');
    await until(() => chat.conversation().openQuestions.length === 1);
    turn.stop();
    await turn;
    const first = chat.conversation().messages.find(({ role }) => role === 'user')!;
    await chat.edit(first.id, 'first, edited');
    expect(chat.answer('name', 'Ada')).toEqual({ ok: false, error: expect.stringMatching(/question 'name' belongs to branch 'main'.*selectBranch/i) });
    expect((await chat.send('Bob')).text).toBe('unrelated reply');
    const statements = chat.conversation().messages.filter(({ role, kind, branchId }) => role === 'user' && kind === 'statement' && branchId !== 'main');
    expect(statements.map(({ parts }) => parts[0])).toEqual([{ type: 'text', text: 'first, edited' }, { type: 'text', text: 'Bob' }]);
    expect(provider.requests[2]!.messages.filter(({ role, text }) => role !== 'system' && text?.startsWith(VOLATILE_HEADING) !== true).at(-1)).toMatchObject({ role: 'user', text: 'Bob' });
    expect(chat.conversation().openQuestions).toHaveLength(1);
  });
});
