import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ProviderMessage } from '../providers/provider-types.js';
import { textTurn, toolTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import type { Patch } from './patches.js';
import { messageText } from './message.js';
import { chatSetup, collect, delay } from './chat.test-support.js';

const TOOL_MS = 40;

const lookup = defineTool({
  name: 'lookup', description: 'Slow read', args: z.object({ key: z.string() }).strict(), deterministic: false, cache: false,
  describeActivity: () => ({ title: 'Looking up' }),
  run: async ({ key }, { signal }) => new Promise(resolve => { const timer = setTimeout(() => resolve(`value of ${key}`), TOOL_MS); signal.addEventListener('abort', () => clearTimeout(timer)); }),
});

const save = defineTool({
  name: 'save', description: 'Slow write', args: z.object({ key: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true,
  describeActivity: () => ({ title: 'Saving' }),
  run: async ({ key }, { signal }) => new Promise(resolve => { const timer = setTimeout(() => resolve(`saved ${key}`), TOOL_MS); signal.addEventListener('abort', () => clearTimeout(timer)); }),
});

const TOOLS = { agent: { tools: [lookup, save] } };

function roles(messages: ProviderMessage[]): string[] {
  return messages.slice(1, -1).map(({ role, text, toolCalls, toolCallId }) => `${role}:${toolCalls?.map(({ id }) => id).join('+') ?? toolCallId ?? text}`);
}

function envelope(messages: ProviderMessage[], callId: string): unknown {
  return JSON.parse(messages.find(({ toolCallId }) => toolCallId === callId)?.text ?? 'null');
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300 && !condition(); attempt += 1) await delay(2);
}

describe('queue delivery', () => {
  it('keeps queue order through edit, move and remove before start, and refuses changes after start', async () => {
    const { agent, provider } = chatSetup({ turns: [textTurn('r0', { delayMs: 15 }), textTurn('r1'), textTurn('r2'), textTurn('r3')] });
    const chat = agent.chat();
    const first = chat.send('zero');
    const [a, b, c] = ['a', 'b', 'c'].map(text => chat.send(text));
    const queued = chat.queue();
    expect(queued.map(({ text }) => text)).toEqual(['a', 'b', 'c']);
    chat.queue.edit(queued[0]!.id, 'a2');
    chat.queue.move(queued[2]!.id, 0);
    chat.queue.remove(queued[1]!.id);
    expect(chat.queue().map(({ text }) => text)).toEqual(['c', 'a2']);
    expect((await b!).status).toBe('cancelled');
    await Promise.all([first, a, c]);
    expect(provider.requests.map(({ messages }) => messages.at(-2)?.text)).toEqual(['zero', 'c', 'a2']);
    expect(() => chat.queue.edit(queued[2]!.id, 'late')).toThrow(/has already started/);
    expect(chat.conversation().messages.filter(({ role }) => role === 'user').map(messageText)).toEqual(['zero', 'c', 'a2']);
  });

  it('coalesces only adjacent messages that ask to, into one turn', async () => {
    const { agent, provider } = chatSetup({ turns: [textTurn('busy', { delayMs: 15 }), textTurn('merged'), textTurn('alone')] });
    const chat = agent.chat({ coalesce: true });
    const busy = chat.send('start');
    const one = chat.send('one');
    const two = chat.send('two');
    const three = chat.send('three', { coalesce: false });
    await Promise.all([busy, one, two, three]);
    expect([(await one).text, (await two).text, (await three).text]).toEqual(['merged', 'merged', 'alone']);
    expect(one.messageId).toBe(two.messageId);
    expect(roles(provider.requests[1]!.messages).slice(-2)).toEqual(['user:one', 'user:two']);
    expect(provider.requests).toHaveLength(3);
  });

  it('lets a per-message delivery override the chat default', async () => {
    const { agent, provider } = chatSetup({ turns: [textTurn('first', { delayMs: 15 }), textTurn('second')], ...TOOLS });
    const chat = agent.chat({ whileBusy: 'steer' });
    const first = chat.send('one');
    const second = chat.send('two', { delivery: 'queue' });
    expect(chat.queue()).toHaveLength(1);
    await Promise.all([first, second]);
    expect(provider.requests).toHaveLength(2);
  });
});

describe('steer delivery', () => {
  it('injects the message at the next safe boundary, after the tool results, with no extra provider call', async () => {
    const { agent, provider } = chatSetup({ turns: [toolTurn([{ id: 'l1', name: 'lookup', args: { key: 'x' } }]), textTurn('Adjusted.')], ...TOOLS });
    const chat = agent.chat();
    const turn = chat.send('look it up');
    await until(() => chat.conversation().messages.some(({ kind }) => kind === 'tool_activity'));
    const steered = chat.send('use metric units', { delivery: 'steer' });
    expect((await turn).text).toBe('Adjusted.');
    expect(await steered).toMatchObject({ text: 'Adjusted.', messageId: turn.messageId });
    expect(provider.requests).toHaveLength(2);
    expect(roles(provider.requests[1]!.messages)).toEqual(['user:look it up', 'assistant:l1', 'tool:l1', 'user:use metric units']);
    expect(chat.conversation().messages.find(({ delivery }) => delivery?.steered === true)).toMatchObject({ role: 'user', delivery: { mode: 'steer', steered: true } });
    // The next request sees the steered message once, inside the reply's own history.
    await chat.send('thanks');
  });

  it('turns a steer that arrives after the last model request into a queued message', async () => {
    const { agent, provider } = chatSetup({ turns: [textTurn('long answer', { chunkSize: 2, delayMs: 5 }), textTurn('about the late one')] });
    const chat = agent.chat();
    const turn = chat.send('question');
    await until(() => provider.requests.length === 1);
    const late = chat.send('also this', { delivery: 'steer' });
    expect((await turn).text).toBe('long answer');
    expect((await late).text).toBe('about the late one');
    const lateMessage = chat.conversation().messages.find(message => message.role === 'user' && messageText(message) === 'also this');
    expect(lateMessage?.delivery).toMatchObject({ mode: 'steer', queuedAt: expect.any(Number) });
    expect(lateMessage?.delivery?.steered).toBeUndefined();
    expect(provider.requests).toHaveLength(2);
  });
});

describe('interrupt delivery', () => {
  it('mid-stream: keeps the partial reply as cancelled, then answers the new message with a valid history', async () => {
    const { agent, provider } = chatSetup({ turns: [textTurn('a very long reply that never ends', { chunkSize: 3, delayMs: 8 }), textTurn('New topic.')] });
    const chat = agent.chat();
    const patches: Patch[] = [];
    chat.subscribe(patch => patches.push(patch));
    const turn = chat.send('tell me everything');
    await until(() => (chat.conversation().messages[1]?.parts[0] as { text: string } | undefined)?.text.length !== 0 && chat.conversation().messages.length > 1);
    const next = chat.send('stop, new topic', { delivery: 'interrupt' });
    const cut = await turn;
    expect(cut.status).toBe('cancelled');
    expect((await next).text).toBe('New topic.');
    const [, partial, interrupting] = chat.conversation().messages;
    expect(partial).toMatchObject({ state: 'cancelled' });
    expect(messageText(partial!).length).toBeGreaterThan(0);
    expect(interrupting).toMatchObject({ delivery: { mode: 'interrupt', interrupted: true } });
    expect(patches.find(({ type }) => type === 'message-interrupted')).toMatchObject({ messageId: partial!.id, byMessageId: interrupting!.id });
    expect(roles(provider.requests[1]!.messages)).toEqual(['user:tell me everything', `assistant:${messageText(partial!)}`, 'user:stop, new topic']);
  });

  it('mid-tool: aborts the read-only tool, lets the side-effecting one finish, and repairs nothing that is valid', async () => {
    const calls = [{ id: 'r1', name: 'lookup', args: { key: 'a' } }, { id: 'w1', name: 'save', args: { key: 'b' } }];
    const { agent, provider } = chatSetup({ turns: [toolTurn(calls), textTurn('ok')], ...TOOLS });
    const chat = agent.chat();
    const turn = chat.send('do both');
    await until(() => chat.conversation().messages.some(({ kind }) => kind === 'tool_activity'));
    const next = chat.send('never mind', { delivery: 'interrupt' });
    expect((await turn).status).toBe('cancelled');
    await next;
    const history = provider.requests[1]!.messages;
    expect(roles(history)).toEqual(['user:do both', 'assistant:r1+w1', 'tool:r1', 'tool:w1', 'user:never mind']);
    expect(envelope(history, 'r1')).toMatchObject({ ok: false, error: { category: 'aborted' } });
    expect(envelope(history, 'w1')).toMatchObject({ ok: true, result: 'saved b' });
  });

  it('mid-tool with force: the side-effecting tool is aborted too', async () => {
    const { agent, provider } = chatSetup({ turns: [toolTurn([{ id: 'w1', name: 'save', args: { key: 'b' } }]), textTurn('ok')], ...TOOLS });
    const chat = agent.chat();
    const turn = chat.send('save');
    await until(() => chat.conversation().messages.some(({ kind }) => kind === 'tool_activity'));
    const next = chat.send('abort it', { delivery: 'interrupt', force: true });
    await Promise.all([turn, next]);
    expect(envelope(provider.requests[1]!.messages, 'w1')).toMatchObject({ ok: false, error: { category: 'aborted' } });
  });

  it('exactly at turn end: the finished reply stays complete and the new message is answered next', async () => {
    const { agent, provider } = chatSetup({ turns: [textTurn('done already'), textTurn('next')] });
    const chat = agent.chat();
    const turn = chat.send('one');
    let next: ReturnType<typeof chat.send> | undefined;
    for await (const event of turn) if (event.type === 'done') next = chat.send('two', { delivery: 'interrupt' });
    expect((await turn).status).toBe('completed');
    expect((await next!).text).toBe('next');
    expect(chat.conversation().messages.map(({ role, state }) => `${role}:${state}`)).toEqual(['user:complete', 'agent:complete', 'user:complete', 'agent:complete']);
    expect(chat.conversation().messages[2]?.delivery).toMatchObject({ mode: 'interrupt', interrupted: false });
    expect(provider.requests).toHaveLength(2);
  });

  it('during ask_user: the waiting turn is cancelled with a valid history, and the question stays open', async () => {
    const question = { id: 'q', text: 'Which?', type: 'text', required: true, options: null, default: null, min: null, max: null };
    const { agent, provider } = chatSetup({ turns: [toolTurn([{ id: 'ask1', name: 'ask_user', args: { questions: [question] } }]), textTurn('fine')] });
    const chat = agent.chat();
    const turn = chat.send('help');
    await until(() => chat.conversation().status === 'waiting_for_user');
    const next = chat.send('forget it', { delivery: 'interrupt' });
    expect((await turn).status).toBe('cancelled');
    await next;
    expect(roles(provider.requests[1]!.messages)).toEqual(['user:help', 'assistant:ask1', 'tool:ask1', 'user:forget it']);
    expect(chat.conversation().openQuestions).toHaveLength(1);
  });
});

describe('stopping a chat turn', () => {
  it('graceful stop ends after the current unit of work; immediate stop cancels', async () => {
    const { agent, provider } = chatSetup({ turns: [toolTurn([{ id: 'l1', name: 'lookup', args: { key: 'x' } }]), textTurn('slow', { chunkSize: 1, delayMs: 20 })], ...TOOLS });
    const chat = agent.chat();
    const graceful = chat.send('look');
    await until(() => chat.conversation().messages.some(({ kind }) => kind === 'tool_activity'));
    graceful.stop({ mode: 'graceful' });
    expect((await graceful).status).toBe('stopped');
    expect(provider.requests).toHaveLength(1);
    const immediate = chat.send('again');
    await delay(5);
    immediate.cancel();
    expect((await immediate).status).toBe('cancelled');
  });

  it("onStop 'discard' drops queued messages when a turn is stopped; the default keeps them", async () => {
    for (const onStop of ['discard', 'keep'] as const) {
      const { agent } = chatSetup({ turns: [textTurn('slow', { chunkSize: 1, delayMs: 10 }), textTurn('kept')] });
      const chat = agent.chat({ onStop });
      const turn = chat.send('one');
      const queued = chat.send('two');
      await delay(5);
      turn.stop();
      expect((await queued).status).toBe(onStop === 'discard' ? 'cancelled' : 'completed');
      expect(chat.conversation().queue).toEqual([]);
    }
  });

  it('cancelling a queued turn before it starts removes it from the queue', async () => {
    const { agent } = chatSetup({ turns: [textTurn('slow', { delayMs: 10 }), textTurn('unused')] });
    const chat = agent.chat();
    const first = chat.send('one');
    const queued = chat.send('two');
    queued.cancel();
    expect((await queued).status).toBe('cancelled');
    expect(chat.conversation().queue).toEqual([]);
    await first;
    expect(chat.conversation().messages).toHaveLength(2);
  });
});

describe('task.steer', () => {
  it('delivers steering text at the safe boundary of a task run', async () => {
    const { agent, provider } = chatSetup({ turns: [toolTurn([{ id: 'l1', name: 'lookup', args: { key: 'x' } }]), textTurn('done')], ...TOOLS });
    const run = agent.task({ task: 'look' });
    setTimeout(() => run.steer('prefer the cache'), 10);
    const events = await collect(run);
    expect(provider.requests).toHaveLength(2);
    expect(roles(provider.requests[1]!.messages).at(-1)).toBe('user:prefer the cache');
    expect(events.filter(({ type }) => type === 'warning')).toEqual([]);
  });
});
