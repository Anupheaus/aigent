import { describe, expect, it } from 'vitest';
import { FEEDBACK_COLLECTION } from '../feedback/feedback-records.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { textTurn } from '../testing/fake-provider.js';
import { ATTACHMENTS_COLLECTION, INLINE_ATTACHMENT_BYTES } from './attachments.js';
import { historyToProvider } from './history-to-provider.js';
import { lineage } from './lineage.js';
import { chatSetup } from './chat.test-support.js';

const PIXEL = new Uint8Array([137, 80, 78, 71]);

describe('attachments', () => {
  it('inlines small text files, references large ones by handle, and stores each content once', async () => {
    const store = createInMemoryStore();
    const big = 'x'.repeat(INLINE_ATTACHMENT_BYTES + 1);
    const { agent, provider } = chatSetup({ turns: [textTurn('read them'), textTurn('again')], store });
    const chat = agent.chat({ attachments: { readAttachment: async ref => ({ name: ref, mimeType: 'text/plain', bytes: new TextEncoder().encode(big) }) } });
    await chat.send({ text: 'see files', attachments: [{ kind: 'file', text: 'hello notes', name: 'notes.md', mimeType: 'text/markdown' }, { kind: 'file', ref: 'big.txt' }] });
    await chat.send({ text: 'same notes', attachments: [{ kind: 'file', text: 'hello notes', name: 'copy.md', mimeType: 'text/markdown' }] });
    await chat.close();
    const sent = provider.requests[0]!.messages.at(-2)!.text!;
    expect(sent).toContain('[Attachment notes.md (text/markdown)]\nhello notes');
    expect(sent).toMatch(/\[Attachment big\.txt \(text\/plain, 8193 bytes\) stored as handle att_[0-9a-f]{64}; its content is not included here\]/);
    expect(sent).not.toContain(big);
    const [user] = chat.conversation().messages;
    expect(user?.parts.map(({ type }) => type)).toEqual(['text', 'file', 'file']);
    expect(user?.meta.attachments?.map(({ inline }) => inline)).toEqual([true, false]);
    expect((await store.list(ATTACHMENTS_COLLECTION)).map(({ value }) => (value as { name: string }).name).sort()).toEqual(['big.txt', 'notes.md']);
  });

  it('needs vision for images unless a describe fallback is configured', async () => {
    const { agent, provider } = chatSetup({ turns: [textTurn('a cat')] });
    const blind = agent.chat();
    await expect(blind.send({ text: 'look', attachments: [{ kind: 'image', bytes: PIXEL, name: 'cat.png', mimeType: 'image/png' }] })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/model 'fake:m' has no vision capability/) });
    const describing = agent.chat({ attachments: { onNoVision: 'describe', describe: async ({ name }) => `a photo named ${name}` } });
    await describing.send({ text: 'look', attachments: [{ kind: 'image', bytes: PIXEL, name: 'cat.png', mimeType: 'image/png' }] });
    expect(provider.requests[0]!.messages.at(-2)?.text).toContain('[Image cat.png: a photo named cat.png]');
    expect(describing.conversation().messages[0]?.parts[1]).toMatchObject({ type: 'image', alt: 'cat.png' });
  });

  it('fails a ref attachment without a reader and keeps later sends in order', async () => {
    const { agent, provider } = chatSetup({ turns: [textTurn('fine')] });
    const chat = agent.chat();
    const broken = chat.send({ text: 'x', attachments: [{ kind: 'file', ref: 'a.txt' }] });
    const next = chat.send('plain');
    await expect(broken).rejects.toThrow(/no attachments.readAttachment/);
    expect((await next).text).toBe('fine');
    expect(provider.requests).toHaveLength(1);
  });
});

describe('pinning and reactions', () => {
  it('pins a message as never compactable and sends it with the pinned flag', async () => {
    const { agent, provider } = chatSetup({ turns: [textTurn('ok'), textTurn('still blue')] });
    const chat = agent.chat();
    const reply = await chat.send('remember: blue');
    const [user] = chat.conversation().messages;
    chat.pin(user!.id);
    expect(chat.conversation()).toMatchObject({ pinned: [user!.id], messages: [{ pinned: true, compactable: false }, {}] });
    expect(historyToProvider(lineage({ state: chat.conversation() }))[0]?.flags).toEqual({ compactable: false, pinned: true });
    expect((await chat.send('which colour?')).text).toBe('still blue');
    expect(provider.requests[1]?.messages[1]?.text).toBe('remember: blue');
    chat.unpin(user!.id);
    expect(chat.conversation().pinned).toEqual([]);
    expect(() => chat.pin('missing')).toThrow(/Unknown message 'missing'/);
    expect(reply.text).toBe('ok');
  });

  it('turns a reaction into stored user feedback on the reply and notes it in the meta', async () => {
    const store = createInMemoryStore();
    const { agent } = chatSetup({ turns: [textTurn('42')], store });
    const chat = agent.chat();
    const reply = await chat.send('answer?');
    await chat.react(reply.messageId, 'down', 'wrong number');
    await chat.close();
    const feedback = await store.get<{ rating: string; comment?: string }>(FEEDBACK_COLLECTION, reply.responseId);
    expect(feedback?.value).toMatchObject({ rating: 'incorrect', comment: 'wrong number' });
    expect(chat.conversation().messages[1]?.meta.userRating).toBe('down');
    await expect(chat.react(chat.conversation().messages[0]!.id, 'up')).rejects.toThrow(/not a finished agent reply/);
  });
});

describe('autoTitle', () => {
  it('is off by default, and when on makes one extra call counted apart', async () => {
    const off = chatSetup({ turns: [textTurn('hi')] });
    const plain = off.agent.chat();
    await plain.send('hello');
    await plain.close();
    expect(off.provider.requests).toHaveLength(1);
    expect(plain.conversation().title).toBeUndefined();
    const on = chatSetup({ turns: [textTurn('hi'), textTurn('Greeting chat\nignored', { usage: { inputTokens: 3, outputTokens: 2, cachedTokens: 0 } }), textTurn('second')] });
    const titled = on.agent.chat({ autoTitle: true });
    await titled.send('hello');
    await titled.send('more');
    await titled.close();
    expect(on.provider.requests).toHaveLength(3);
    expect(on.provider.requests[1]?.tools).toEqual([]);
    expect(titled.conversation()).toMatchObject({ title: 'Greeting chat', usage: { title: { inputTokens: 3, outputTokens: 2 }, replies: 2 } });
  });
});
