import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { textTurn } from '../testing/fake-provider.js';
import { messageText } from './message.js';
import { chatSetup } from './chat.test-support.js';

function texts(messages: { role: string; text?: string }[]): string[] {
  return messages.slice(1, -1).map(({ role, text }) => `${role}:${text}`);
}

describe('threads', () => {
  it('answers a reply in a thread with the root, the thread and a short main summary only', async () => {
    const long = (topic: string): string => `${topic} `.repeat(120);
    const turns = [`Answer one about apples. ${long('apples')}`, `Answer two about pears. ${long('pears')}`, 'Thread answer.', 'Second thread answer.', 'Main again.'].map(text => textTurn(text));
    const { agent, provider } = chatSetup({ turns });
    const chat = agent.chat();
    const first = await chat.send('Tell me about apples');
    await chat.send('Tell me about pears');
    const threaded = await chat.send('Why apples?', { replyTo: first.messageId });
    await chat.send({ text: 'And green ones?', replyTo: threaded.messageId });
    await chat.send('Back to the main line');
    const threadRequest = provider.requests[3]!.messages;
    expect(threadRequest[1]?.text).toMatch(/^# Thread context\n/);
    expect(threadRequest[1]?.text).toContain('- user: Tell me about pears');
    expect(texts(threadRequest).slice(1)).toEqual([`assistant:Answer one about apples. ${long('apples')}`, 'user:Why apples?', 'assistant:Thread answer.', 'user:And green ones?']);
    const full = provider.requests[4]!.messages;
    expect(JSON.stringify(threadRequest).length).toBeLessThan(JSON.stringify(full).length);
    // The main line never sees the thread.
    expect(full.some(({ text }) => text === 'Why apples?')).toBe(false);
    const thread = chat.thread(first.messageId);
    expect(thread.messages().map(messageText)).toEqual(['Why apples?', 'Thread answer.', 'And green ones?', 'Second thread answer.']);
    expect(chat.conversation().threads).toEqual([expect.objectContaining({ id: first.messageId, messageIds: thread.messages().map(({ id }) => id) })]);
  });

  it('promotes a thread into the main line as a summary message', async () => {
    const { agent, provider } = chatSetup({ turns: ['Root answer', 'Thread answer', 'Saw the summary'].map(text => textTurn(text)) });
    const chat = agent.chat();
    const root = await chat.send('root');
    await chat.send('side question', { replyTo: root.messageId });
    const summary = chat.thread(root.messageId).promote();
    expect(summary).toMatchObject({ kind: 'summary', role: 'system', compactable: false });
    expect(messageText(summary)).toContain('- user: side question');
    await chat.send('continue');
    expect(provider.requests[2]!.messages.some(({ text }) => text?.startsWith('[Thread summary]'))).toBe(true);
    expect(chat.conversation().threads[0]?.promotedAt).toEqual(expect.any(Number));
  });
});

describe('branches', () => {
  it('edit and regenerate start new branches, keep the old ones, and the model sees only the active lineage', async () => {
    const turns = ['A1', 'A2', 'A2 edited', 'A2 again'].map(text => textTurn(text));
    const { agent, provider } = chatSetup({ turns });
    const chat = agent.chat();
    await chat.send('one');
    await chat.send('two');
    const [, , two] = chat.history();
    const edited = await chat.edit(two!.id, 'two, edited');
    expect(edited.text).toBe('A2 edited');
    expect(texts(provider.requests[2]!.messages)).toEqual(['user:one', 'assistant:A1', 'user:two, edited']);
    const editedBranch = chat.conversation().branchId;
    const regenerated = await chat.regenerate(edited.messageId);
    expect(regenerated.text).toBe('A2 again');
    expect(texts(provider.requests[3]!.messages)).toEqual(['user:one', 'assistant:A1', 'user:two, edited']);
    expect(chat.branches().map(({ reason, parentBranchId }) => [reason, parentBranchId])).toEqual([['root', undefined], ['edit', 'main'], ['regenerate', editedBranch]]);
    expect(chat.history().map(messageText)).toEqual(['one', 'A1', 'two, edited', 'A2 again']);
    chat.selectBranch('main');
    expect(chat.history().map(messageText)).toEqual(['one', 'A1', 'two', 'A2']);
    // Nothing was deleted.
    expect(chat.conversation().messages).toHaveLength(7);
  });

  it('refuses to change branches while busy and names unknown branches', async () => {
    const { agent } = chatSetup({ turns: [textTurn('slow', { delayMs: 10 })] });
    const chat = agent.chat();
    const turn = chat.send('x');
    expect(() => chat.selectBranch('main')).toThrow(/while the agent is busy/);
    await turn;
    expect(() => chat.selectBranch('nope')).toThrow(/Unknown branch 'nope'/);
    expect(() => chat.edit(chat.history()[1]!.id, 'x')).toThrow(/Only a user's message can be edited/);
  });
});

describe('fork', () => {
  it('creates an independent session from the fork point, recording its parent', async () => {
    const store = createInMemoryStore();
    const { agent, provider } = chatSetup({ turns: ['A1', 'A2', 'fork reply', 'parent reply'].map(text => textTurn(text)), store });
    const chat = agent.chat();
    const first = await chat.send('one');
    await chat.send('two');
    const fork = chat.fork({ atMessageId: first.messageId });
    await fork.ready;
    expect(fork.sessionId).not.toBe(chat.sessionId);
    expect(fork.conversation().fork).toEqual({ parentSessionId: chat.sessionId, forkPoint: first.messageId });
    expect(fork.history().map(messageText)).toEqual(['one', 'A1']);
    await fork.send('fork only');
    await chat.send('parent only');
    expect(texts(provider.requests[2]!.messages)).toEqual(['user:one', 'assistant:A1', 'user:fork only']);
    expect(provider.requests[3]!.messages.some(({ text }) => text === 'fork only')).toBe(false);
    await fork.close();
    const reopened = agent.chat({ sessionId: fork.sessionId });
    await reopened.ready;
    expect(reopened.conversation()).toEqual(fork.conversation());
    expect(() => chat.fork({ atMessageId: 'missing' })).toThrow(/not on the active branch/);
  });
});
