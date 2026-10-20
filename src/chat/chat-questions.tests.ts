import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { textTurn, toolTurn } from '../testing/fake-provider.js';
import { parseToolArgs } from '../tools/parse-tool-args.js';
import { createAskUserTool } from './ask-user-tool.js';
import { chatSetup, collect, delay } from './chat.test-support.js';

const NAME = { id: 'name', text: 'Your name?', type: 'text', required: true, options: null, default: null, min: null, max: null };
const SIZE = { id: 'size', text: 'Size?', type: 'single_choice', required: true, options: [{ value: 's', label: 'Small' }, { value: 'l', label: 'Large' }], default: 's', min: null, max: null };

function askCall(questions: unknown[], id = 'ask1') {
  return { id, name: 'ask_user', args: { questions } };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await delay(2);
}

describe('ask_user schema', () => {
  const tool = createAskUserTool(async () => []);

  it('accepts a valid batch in the strict form models send (null for absent fields)', () => {
    expect(tool.strict).toBe(true);
    expect(parseToolArgs(tool.argsSchema, { questions: [NAME, SIZE] })).toMatchObject({ ok: true });
  });

  it.each([
    ['no questions', { questions: [] }, /questions/],
    ['eleven questions', { questions: Array.from({ length: 11 }, (_unused, index) => ({ ...NAME, id: `q${index}` })) }, /questions/],
    ['a duplicate id', { questions: [NAME, NAME] }, /duplicate question id 'name'/],
    ['a choice without options', { questions: [{ ...SIZE, options: null }] }, /needs 2 to 20 options/],
    ['one option', { questions: [{ ...SIZE, options: [{ value: 's', label: 'Small' }] }] }, /options/],
    ['options on a text question', { questions: [{ ...NAME, options: SIZE.options }] }, /takes no options/],
    ['an id over 40 characters', { questions: [{ ...NAME, id: 'x'.repeat(41) }] }, /id/],
    ['an unknown type', { questions: [{ ...NAME, type: 'date' }] }, /type/],
    ['min above max', { questions: [{ ...NAME, type: 'number', min: 10, max: 1 }] }, /min 10 is above max 1/],
    ['min or max on a confirm question', { questions: [{ ...NAME, type: 'confirm', max: 1 }] }, /confirm question 'name' takes no min or max/],
    ['min or max on a single choice', { questions: [{ ...SIZE, min: 1 }] }, /single_choice question 'size' takes no min or max/],
    ['more required choices than options', { questions: [{ ...SIZE, type: 'multi_choice', default: null, min: 3 }] }, /needs at least 3 choices but has only 2 options/],
    ['a default that is not an option', { questions: [{ ...SIZE, default: 'xl' }] }, /default of question 'size' is invalid: expected one of s, l/],
    ['a number default that is not a number', { questions: [{ ...NAME, type: 'number', default: 'lots' }] }, /default of question 'name' is invalid: expected a number/],
    ['a number default out of range', { questions: [{ ...NAME, type: 'number', default: '50', max: 10 }] }, /default of question 'name' is invalid: must be at most 10/],
    ['a confirm default other than yes or no', { questions: [{ ...NAME, type: 'confirm', default: 'maybe' }] }, /default of question 'name' is invalid: expected yes or no/],
    ['duplicate option values', { questions: [{ ...SIZE, options: [{ value: 's', label: 'Small' }, { value: 's', label: 'Smaller' }] }] }, /option 's' of question 'size' is ambiguous/],
    ['a label equal to another option', { questions: [{ ...SIZE, options: [{ value: 's', label: 'Small' }, { value: 'l', label: 'S' }] }] }, /option 's' of question 'size' is ambiguous/],
    ['a comma in a multi-choice option', { questions: [{ ...SIZE, type: 'multi_choice', default: null, options: [{ value: 'a,b', label: 'A and B' }, { value: 'c', label: 'C' }] }] }, /option 'a,b' of question 'size' contains a comma/],
  ])('rejects %s', (_name, args, message) => {
    const parsed = parseToolArgs(tool.argsSchema, args);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).toMatch(message);
  });
});

describe('ask_user in chat', () => {
  it('suspends the turn without provider calls, keeps a partly answered batch open, and resumes with every answer', async () => {
    const { agent, provider } = chatSetup({ turns: [toolTurn([askCall([NAME, SIZE])]), textTurn('Thanks, Ada.')] });
    const chat = agent.chat();
    const turn = chat.send('order a shirt');
    await until(() => chat.conversation().openQuestions.length === 2);
    await delay(20);
    expect(chat.conversation().status).toBe('waiting_for_user');
    expect(provider.requests).toHaveLength(1);
    expect(chat.answer('size', 'medium')).toEqual({ ok: false, error: expect.stringMatching(/question 'size' \(single_choice\) is invalid: expected one of s, l/) });
    expect(chat.answer('name', 'Ada')).toEqual({ ok: true });
    await delay(10);
    expect(provider.requests).toHaveLength(1);
    expect(chat.conversation().openQuestions.map(({ question }) => question.id)).toEqual(['size']);
    expect(chat.answer('size', 'Large')).toEqual({ ok: true });
    expect((await turn).text).toBe('Thanks, Ada.');
    const result = provider.requests[1]!.messages.find(({ role, toolCallId }) => role === 'tool' && toolCallId === 'ask1');
    expect(JSON.parse(result!.text!)).toMatchObject({ ok: true, result: [{ id: 'name', ok: true, value: 'Ada' }, { id: 'size', ok: true, value: 'l' }] });
    // Delivered as the call's result, so the answers are not repeated as user text.
    expect(provider.requests[1]!.messages.filter(({ text }) => text?.startsWith('Answer to your question'))).toEqual([]);
    expect(chat.conversation().status).toBe('idle');
  });

  it('closes the unanswered optional questions of a completed batch as skipped, so the next message is a new message', async () => {
    const colour = { ...NAME, id: 'colour', text: 'Colour?', required: false };
    const fit = { ...NAME, id: 'fit', text: 'Fit?', required: false };
    const { agent, provider } = chatSetup({ turns: [toolTurn([askCall([colour, fit])]), textTurn('Blue it is'), textTurn('New topic')] });
    const chat = agent.chat();
    const turn = chat.send('order a shirt');
    await until(() => chat.conversation().openQuestions.length === 2);
    expect(chat.answer('colour', 'blue')).toEqual({ ok: true });
    await turn;
    expect(chat.conversation().openQuestions).toEqual([]);
    const fitQuestion = chat.conversation().messages.find(({ meta }) => meta.questionMeta?.questionId === 'fit')!;
    expect(fitQuestion.meta.questionMeta).toMatchObject({ answered: false, skipped: true });
    const skipped = chat.conversation().messages.find(({ id }) => id === fitQuestion.meta.answerMessageId)!;
    expect(skipped).toMatchObject({ role: 'user', kind: 'answer', replyTo: fitQuestion.id, parts: [{ type: 'text', text: '(skipped)' }], meta: { answeredQuestionId: 'fit' } });
    const envelope = JSON.parse(provider.requests[1]!.messages.find(({ toolCallId }) => toolCallId === 'ask1')!.text!);
    expect(envelope.result).toEqual([{ id: 'colour', ok: true, value: 'blue' }, { id: 'fit', ok: false, value: null, error: 'not answered' }]);
    expect((await chat.send('hello, new topic')).text).toBe('New topic');
    const statements = chat.conversation().messages.filter(({ role, kind }) => role === 'user' && kind === 'statement');
    expect(statements.map(({ parts }) => parts[0])).toEqual([{ type: 'text', text: 'order a shirt' }, { type: 'text', text: 'hello, new topic' }]);
    expect(provider.requests[2]!.messages.some(({ text }) => text?.startsWith("Answer to your question 'fit'"))).toBe(false);
  });

  it('also closes the other optional questions when an answer resumes a stopped turn', async () => {
    const colour = { ...NAME, id: 'colour', text: 'Colour?', required: false };
    const fit = { ...NAME, id: 'fit', text: 'Fit?', required: false };
    const { agent } = chatSetup({ turns: [toolTurn([askCall([colour, fit])]), textTurn('Blue it is')] });
    const chat = agent.chat();
    const turn = chat.send('order a shirt');
    await until(() => chat.conversation().openQuestions.length === 2);
    turn.stop();
    await turn;
    expect(chat.answer('colour', 'blue')).toEqual({ ok: true, turn: expect.anything() });
    expect(chat.conversation().openQuestions).toEqual([]);
    await chat.close();
    expect(chat.conversation().messages.at(-1)).toMatchObject({ role: 'agent', parts: [{ type: 'text', text: 'Blue it is' }] });
  });

  it('links question and answer messages both ways and keeps them out of compaction', async () => {
    const { agent } = chatSetup({ turns: [toolTurn([askCall([NAME])]), textTurn('ok')] });
    const chat = agent.chat();
    const turn = chat.send('hi');
    await until(() => chat.conversation().openQuestions.length === 1);
    chat.answer('name', 'Ada');
    await turn;
    const { messages } = chat.conversation();
    const question = messages.find(({ kind }) => kind === 'question')!;
    const answer = messages.find(({ kind }) => kind === 'answer')!;
    expect(question).toMatchObject({ role: 'agent', compactable: false, parts: [{ type: 'text', text: 'Your name?' }, { type: 'question', questionId: 'name' }], meta: { questionMeta: { questionId: 'name', type: 'text', answered: true, callId: 'ask1' }, answerMessageId: answer.id } });
    expect(answer).toMatchObject({ role: 'user', compactable: false, replyTo: question.id, meta: { answeredQuestionId: 'name' } });
  });

  it('treats a plain reply as the answer while exactly one question is open', async () => {
    const { agent, provider } = chatSetup({ turns: [toolTurn([askCall([NAME])]), textTurn('Hello Ada')] });
    const chat = agent.chat();
    const first = chat.send('hi');
    await until(() => chat.conversation().openQuestions.length === 1);
    const reply = chat.send('Ada');
    expect(reply.messageId).toBe(first.messageId);
    expect((await reply).text).toBe('Hello Ada');
    expect(provider.requests).toHaveLength(2);
    expect(chat.conversation().messages.filter(({ kind, role }) => role === 'user' && kind === 'statement')).toHaveLength(1);
  });

  it('cancels a waiting turn on stop, keeping its question open and answerable in a fresh turn', async () => {
    const { agent, provider } = chatSetup({ turns: [toolTurn([askCall([NAME])]), textTurn('Got it')] });
    const chat = agent.chat();
    const turn = chat.send('hi');
    await until(() => chat.conversation().openQuestions.length === 1);
    turn.stop();
    expect((await turn).status).toBe('cancelled');
    expect(chat.conversation()).toMatchObject({ status: 'idle', openQuestions: [{ question: { id: 'name' } }] });
    expect(chat.answer('name', 'Ada')).toEqual({ ok: true, turn: expect.anything() });
    await chat.close();
    const messages = provider.requests[1]!.messages;
    expect(messages.find(({ toolCallId }) => toolCallId === 'ask1')?.text).toContain('"category":"aborted"');
    expect(messages.some(({ text }) => text === 'Answer to your question \'name\' ("Your name?"): Ada')).toBe(true);
  });

  it('keeps open questions across close and reopen, and answering then resumes in a fresh turn', async () => {
    const store = createInMemoryStore();
    const { agent, provider } = chatSetup({ turns: [toolTurn([askCall([NAME])]), textTurn('Welcome back, Ada')], store });
    const chat = agent.chat({ sessionId: 's-q' });
    const turn = chat.send('hi');
    await until(() => chat.conversation().openQuestions.length === 1);
    await chat.close();
    expect((await turn).status).toBe('cancelled');
    const reopened = agent.chat({ sessionId: 's-q' });
    await reopened.ready;
    expect(reopened.conversation().openQuestions.map(({ question }) => question.id)).toEqual(['name']);
    expect(reopened.answer('name', 'Ada')).toEqual({ ok: true, turn: expect.anything() });
    await reopened.close();
    expect(reopened.conversation().messages.at(-1)).toMatchObject({ role: 'agent', state: 'complete', parts: [{ type: 'text', text: 'Welcome back, Ada' }] });
    expect(provider.requests).toHaveLength(2);
  });

  it('ai.close() closes a chat whose turn waits for an answer instead of hanging', async () => {
    const { agent, ai } = chatSetup({ turns: [toolTurn([askCall([NAME])])] });
    const chat = agent.chat();
    const turn = chat.send('hi');
    await until(() => chat.conversation().status === 'waiting_for_user');
    await ai.close();
    expect((await turn).status).toBe('cancelled');
    expect(chat.conversation().openQuestions).toHaveLength(1);
  });

  it('does not offer ask_user when unattended, and refuses a call to it', async () => {
    const { agent, provider } = chatSetup({ turns: [toolTurn([askCall([NAME])]), textTurn('Assuming Ada')] });
    const chat = agent.chat({ unattended: true });
    const events = await collect(chat.send('hi'));
    expect(provider.requests[0]!.tools.map(({ name }) => name)).not.toContain('ask_user');
    expect(events.find(event => event.type === 'tool-result')).toMatchObject({ envelope: { ok: false, error: { category: 'denied', code: 'no_user' } } });
    expect(chat.conversation().openQuestions).toEqual([]);
  });
});

describe('ask_user in task mode', () => {
  it('registers ask_user only with onQuestion, which answers each batch with validated values', async () => {
    const { agent, provider } = chatSetup({ turns: [toolTurn([askCall([NAME, SIZE])]), textTurn('done'), textTurn('plain')] });
    const asked: string[][] = [];
    const result = await agent.task({ task: 'order', onQuestion: async questions => { asked.push(questions.map(({ id }) => id)); return { name: 'Ada', size: 'huge' }; } });
    expect(result.status).toBe('completed');
    expect(asked).toEqual([['name', 'size']]);
    const envelope = JSON.parse(provider.requests[1]!.messages.find(({ toolCallId }) => toolCallId === 'ask1')!.text!);
    expect(envelope.result).toEqual([{ id: 'name', ok: true, value: 'Ada' }, { id: 'size', ok: false, value: null, error: expect.stringMatching(/expected one of s, l/) }]);
    await agent.task({ task: 'no user' });
    expect(provider.requests[2]!.tools.map(({ name }) => name)).not.toContain('ask_user');
  });
});
