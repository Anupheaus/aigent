import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chatSetup } from '../chat/chat.test-support.js';
import { defineGuardrail } from '../guardrails/define-guardrail.js';
import type { GuardrailOptions } from '../guardrails/guardrail-types.js';
import { CHECKPOINTS_COLLECTION } from '../resume/checkpoint-types.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider, textTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import type { AigentEvent } from './aigent-events.js';
import { createAigent } from './create-aigent.js';

const SECRET = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789';
const EMAIL = 'ada.lovelace@example.org';
const SMALL_CHUNKS = { chunkSize: 3 };

function setup(params: { turns: FakeTurn[]; guardrails?: GuardrailOptions; resume?: boolean }) {
  const { turns, guardrails, resume = false } = params;
  const provider = createFakeProvider({ turns });
  const store = createInMemoryStore();
  const ai = createAigent({ providers: [provider], store, enableFeedback: false, ...(guardrails == null ? {} : { guardrails }), ...(resume ? { resume: {} } : {}) });
  return { ai, provider, store, agent: ai.agent({ name: 'helper', model: 'fake:m', ...(resume ? { instanceId: 'inst' } : {}) }) };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function streamed(events: AigentEvent[], type: 'text-delta' | 'thinking-delta'): string {
  return events.flatMap(event => (event.type === type ? [event.text] : [])).join('');
}

/** A reasoning stream in small chunks, then a text answer. */
function thinkingTurn(params: { thinking: string; text: string }): FakeTurn {
  const { thinking, text } = params;
  const chunks = thinking.match(/.{1,4}/gs) ?? [];
  return { events: [...chunks.map(chunk => ({ type: 'thinking-delta' as const, text: chunk })), ...textTurn(text).events] };
}

describe('the streamed answer agrees with the output guardrails', () => {
  it('redacts PII in the stream when output PII is redacted, so the stream never shows what the answer hides', async () => {
    const { agent } = setup({ turns: [textTurn(`Contact ${EMAIL} now`, SMALL_CHUNKS)], guardrails: { builtins: { pii: { output: 'redact' } } } });
    const run = agent.task({ task: 'contact?' });
    const events = await collect(run);
    expect(streamed(events, 'text-delta')).not.toContain(EMAIL);
    expect((await run).answer).toBe('Contact [REDACTED:email] now');
  });

  it('retracts streamed text an output guardrail changed, giving the settled answer as its replacement', async () => {
    const noPrices = defineGuardrail({ name: 'no-prices', stage: 'output', check: value => (typeof value === 'string' && value.includes('$') ? { action: 'rewrite', value: value.replace(/\$\d+/g, '[price]'), note: 'prices hidden' } : { action: 'allow' }) });
    const { agent } = setup({ turns: [textTurn('It costs $40.')], guardrails: { custom: [noPrices] } });
    const run = agent.task({ task: 'price?' });
    const events = await collect(run);
    expect(events).toContainEqual({ type: 'text-retracted', text: 'It costs $40.', replacement: 'It costs [price].', reason: expect.any(String) });
    expect((await run).answer).toBe('It costs [price].');
  });

  it('retracts an answer sent back for output_invalid before the retried one streams', async () => {
    const { agent } = setup({ turns: [textTurn('nope'), textTurn('{"ok":true}')] });
    const run = agent.task({ task: 'json', output: z.object({ ok: z.boolean() }) });
    const events = await collect(run);
    const retracted = events.findIndex(event => event.type === 'text-retracted');
    expect(events[retracted]).toMatchObject({ type: 'text-retracted', text: 'nope', reason: expect.stringMatching(/output_invalid/) });
    expect(events[retracted]).not.toHaveProperty('replacement');
    expect(events.findIndex(event => event.type === 'text-delta' && event.text.includes('ok'))).toBeGreaterThan(retracted);
    expect((await run).output).toEqual({ ok: true });
  });
});

describe('stream checks that are not synchronous', () => {
  it('warns once per run, not once per released segment', async () => {
    const slow = defineGuardrail({ name: 'slow', stage: 'stream', check: async () => ({ action: 'allow' }) });
    const { agent } = setup({ turns: [textTurn('x'.repeat(400), SMALL_CHUNKS)], guardrails: { custom: [slow], failMode: 'open' } });
    const events = await collect(agent.task({ task: 'talk' }));
    expect(events.filter(event => event.type === 'warning' && event.message.includes('must be synchronous'))).toHaveLength(1);
  });
});

describe('reasoning and stored transcripts', () => {
  it('a chat message shows the settled answer after a retraction', async () => {
    const noPrices = defineGuardrail({ name: 'no-prices', stage: 'output', check: value => (typeof value === 'string' && value.includes('$') ? { action: 'rewrite', value: value.replace(/\$\d+/g, '[price]'), note: 'prices hidden' } : { action: 'allow' }) });
    const { agent } = chatSetup({ turns: [textTurn('It costs $40.')], runtime: { guardrails: { custom: [noPrices] } } });
    const chat = agent.chat();
    const reply = await chat.send('price?');
    const message = chat.conversation().messages.find(({ id }) => id === reply.messageId);
    expect(reply.text).toBe('It costs [price].');
    expect(message?.parts[0]).toEqual({ type: 'text', text: 'It costs [price].' });
    await chat.close();
  });

  it('redacts secrets in streamed reasoning and in thinking-done', async () => {
    const { agent } = setup({ turns: [thinkingTurn({ thinking: `The key is ${SECRET} from the env.`, text: 'Done.' })] });
    const run = agent.task({ task: 'think', modelSettings: { showThinking: true } });
    const thinking: string[] = [];
    const reading: Promise<void>[] = [];
    run.onThinking(stream => { reading.push((async () => { for await (const text of stream) thinking.push(text); })()); });
    const events = await collect(run);
    await run;
    await Promise.all(reading);
    expect(streamed(events, 'thinking-delta')).not.toContain(SECRET);
    const done = events.flatMap(event => (event.type === 'thinking-done' ? [event.text] : [])).join('');
    expect(done).toContain('[REDACTED:api-key]');
    expect(done).not.toContain(SECRET);
    expect(thinking.join('')).toBe(done);
  });

  it('never persists a streamed secret: checkpoints keep the guarded text', async () => {
    const { agent, store } = setup({ turns: [textTurn(`Your key is ${SECRET}`, SMALL_CHUNKS)], resume: true });
    await agent.ready;
    const result = await agent.task({ task: 'key?' });
    expect(result.answer).not.toContain(SECRET);
    expect(JSON.stringify(await store.list(CHECKPOINTS_COLLECTION))).not.toContain(SECRET);
  });

  it('never persists a streamed secret in the chat history', async () => {
    const store = createInMemoryStore();
    const { agent } = chatSetup({ turns: [textTurn(`Your key is ${SECRET}`, SMALL_CHUNKS)], store });
    const chat = agent.chat();
    const reply = await chat.send('key?');
    await chat.close();
    expect(reply.text).not.toContain(SECRET);
    expect(JSON.stringify(await store.list('chats'))).not.toContain(SECRET);
  });
});
