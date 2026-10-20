import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { textTurn, toolTurn } from '../testing/fake-provider.js';
import { RUNS_COLLECTION } from '../telemetry/collections.js';
import type { RunRecord } from '../telemetry/run-record.js';
import { createEmptyConversation } from './conversation.js';
import { reduceConversation } from './reduce-conversation.js';
import type { Patch } from './patches.js';
import { chatSetup, collect, spyStore } from './chat.test-support.js';

describe('agent.chat', () => {
  it('answers a message, streaming deltas into the agent message, and records the exchange as patches', async () => {
    const { agent, provider } = chatSetup({ turns: [textTurn('Hello there, friend', { chunkSize: 4 })] });
    const chat = agent.chat();
    const patches: Patch[] = [];
    chat.subscribe(patch => patches.push(patch));
    const turn = chat.send('Hi');
    const events = await collect(turn);
    const reply = await turn;
    expect(reply).toMatchObject({ text: 'Hello there, friend', status: 'completed', messageId: turn.messageId });
    expect(events.at(-1)?.type).toBe('done');
    const state = chat.conversation();
    expect(state.status).toBe('idle');
    expect(state.messages.map(({ role, kind, state: messageState }) => [role, kind, messageState])).toEqual([['user', 'statement', 'complete'], ['agent', 'statement', 'complete']]);
    const deltas = patches.flatMap(patch => (patch.type === 'message-updated' && patch.messageId === turn.messageId && patch.delta != null ? [patch.delta] : []));
    expect(deltas.join('')).toBe('Hello there, friend');
    expect(deltas.length).toBeGreaterThan(1);
    expect(patches.map(({ seq }) => seq)).toEqual(patches.map((_patch, index) => index + 1));
    expect(patches.reduce(reduceConversation, createEmptyConversation({ sessionId: chat.sessionId, agentName: 'helper' }))).toEqual(state);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.messages.map(({ role }) => role)).toEqual(['system', 'user', 'user']);
    expect(provider.requests[0]?.messages[1]?.text).toBe('Hi');
  });

  it('shows tool calls as a collapsible tool_activity row per model request, and the second send sees the whole first exchange', async () => {
    const call = { id: 'c1', name: 'echo', args: { text: 'x' } };
    const { agent, provider } = chatSetup({ turns: [toolTurn([call]), textTurn('Echoed.'), textTurn('Still here.')] });
    const chat = agent.chat();
    await chat.send('echo x');
    await chat.send('and now?');
    const [, , rows] = chat.conversation().messages;
    expect(rows).toMatchObject({ role: 'tool', kind: 'tool_activity', state: 'complete', parts: [{ type: 'tool_call', callId: 'c1', name: 'echo' }, { type: 'tool_result', callId: 'c1', ok: true }] });
    const third = provider.requests[2]!.messages.map(({ role, text, toolCalls }) => [role, toolCalls?.[0]?.id ?? text]);
    expect(third.slice(1, -1)).toEqual([['user', 'echo x'], ['assistant', 'c1'], ['tool', expect.stringContaining('"ok":true')], ['assistant', 'Echoed.'], ['user', 'and now?']]);
  });

  it('gives the reply the same figures as its run record', async () => {
    const store = createInMemoryStore();
    const { agent } = chatSetup({ turns: [toolTurn([{ id: 'c1', name: 'echo', args: { text: 'x' } }]), textTurn('Done.')], store, runtime: { pricing: { 'fake:m': { inputPerMTokUsd: 1, outputPerMTokUsd: 2 } } } });
    const chat = agent.chat();
    const reply = await chat.send('go');
    await chat.close();
    const record = (await store.get<RunRecord>(RUNS_COLLECTION, chat.conversation().messages[1]!.meta.runId!))!.value;
    const { meta } = chat.conversation().messages.find(({ id }) => id === reply.messageId)!;
    expect(record).toMatchObject({ mode: 'chat', responseId: reply.responseId });
    expect(meta).toMatchObject({
      runId: record.runId, responseId: record.responseId, provider: 'fake', model: 'm', toolCalls: record.usage.toolCalls, cacheHits: 0,
      tokens: { input: record.usage.inputTokens, output: record.usage.outputTokens, cached: record.usage.cachedTokens },
      timing: { startedAt: record.timings.startedAt, totalMs: record.timings.durationMs, toolMs: record.timings.toolMs },
      costUsd: (record.usage.inputTokens * 1 + record.usage.outputTokens * 2) / 1_000_000,
    });
    expect(chat.conversation().usage).toMatchObject({ inputTokens: record.usage.inputTokens, replies: 1, turns: 2, toolCalls: 1 });
  });

  it('keeps sessions of one agent isolated', async () => {
    const { agent, provider } = chatSetup({ turns: [textTurn('A1'), textTurn('B1'), textTurn('A2')] });
    const first = agent.chat();
    const second = agent.chat();
    await first.send('secret A');
    await second.send('hello B');
    await first.send('again A');
    expect(provider.requests[1]!.messages.some(({ text }) => text?.includes('secret A'))).toBe(false);
    expect(provider.requests[2]!.messages.some(({ text }) => text?.includes('hello B'))).toBe(false);
    expect(first.conversation().messages).toHaveLength(4);
    expect(second.conversation().messages).toHaveLength(2);
  });

  it('reopens a stored session by id with the identical snapshot, and replays exactly the missed patches', async () => {
    const store = createInMemoryStore();
    const { agent } = chatSetup({ turns: [textTurn('One', { chunkSize: 1 }), textTurn('Two')], store });
    const chat = agent.chat({ sessionId: 'session-1' });
    await chat.send('first');
    await chat.send('second');
    await chat.close();
    const original = chat.conversation();
    const reopened = agent.chat({ sessionId: 'session-1' });
    await reopened.ready;
    expect(reopened.conversation()).toEqual(original);
    const missed: Patch[] = [];
    reopened.subscribe(patch => missed.push(patch), { fromSeq: 5 });
    await reopened.ready;
    expect(missed.map(({ seq }) => seq)).toEqual(Array.from({ length: original.seq - 4 }, (_unused, index) => index + 5));
    const prefix: Patch[] = [];
    chat.subscribe(patch => prefix.push(patch), { fromSeq: 1 });
    expect(prefix.slice(0, 4).reduce(reduceConversation, createEmptyConversation({ sessionId: 'session-1', agentName: 'helper' })).seq).toBe(4);
  });

  it("writes nothing with persistence 'memory', and nothing but run records otherwise", async () => {
    const store = spyStore();
    const { agent } = chatSetup({ turns: [textTurn('ok'), textTurn('ok')], store });
    const memory = agent.chat({ persistence: 'memory' });
    await memory.send('hi');
    await memory.close();
    expect(store.writes.filter(collection => collection === 'chats')).toEqual([]);
    const stored = agent.chat();
    await stored.send('hi');
    await stored.close();
    expect(store.writes.filter(collection => collection === 'chats').length).toBeGreaterThan(0);
  });

  it('rejects store persistence without a store', () => {
    const { agent } = chatSetup({ turns: [] });
    expect(() => agent.chat({ persistence: 'store' })).toThrow(/needs createAigent\(\{ store \}\)/);
    expect(() => agent.chat({ whileBusy: 'later' as never })).toThrow(/Invalid chat options/);
  });
});
