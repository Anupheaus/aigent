import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { GuardrailOptions } from '../guardrails/guardrail-types.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider, textTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import type { AigentEvent } from './aigent-events.js';
import { createAigent } from './create-aigent.js';

const SECRET = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789';

function setup(params: { turns: FakeTurn[]; guardrails?: GuardrailOptions }) {
  const { turns, guardrails } = params;
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false, ...(guardrails == null ? {} : { guardrails }) });
  return { ai, provider, agent: ai.agent({ name: 'helper', model: 'fake:m' }) };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('structured output and the output guardrails', () => {
  it('a run failing output_invalid returns its answer redacted, never raw', async () => {
    const invalid = textTurn(`not json, but here is ${SECRET}`);
    const { agent } = setup({ turns: [invalid, invalid, invalid] });
    const run = agent.task({ task: 'give me json', output: z.object({ ok: z.boolean() }) });
    const result = await run;
    expect(result.status).toBe('failed');
    expect(result.failure).toMatch(/output_invalid/);
    expect(result.answer).not.toContain(SECRET);
    expect(result.answer).toContain('[REDACTED:api-key]');
  });

  it('validates the answer as the model wrote it: a redaction never makes a valid answer fail or retry', async () => {
    const { agent, provider } = setup({ turns: [textTurn('{"email":"ada.lovelace@example.org"}')], guardrails: { builtins: { pii: { output: 'redact' } } } });
    const run = agent.task({ task: 'contact?', output: z.object({ email: z.email() }) });
    const events = await collect(run);
    const result = await run;
    expect(provider.requests).toHaveLength(1);
    expect(result.status).toBe('completed');
    expect(result.answer).not.toContain('ada.lovelace@example.org');
    // The redacted answer no longer matches the schema: no output, and the consumer is told why.
    expect(result.output).toBeUndefined();
    expect(events).toContainEqual({ type: 'warning', message: expect.stringMatching(/no longer matches the output schema/) });
  });

  it('keeps the output when a redaction leaves it valid', async () => {
    const { agent } = setup({ turns: [textTurn(`{"note":"key ${SECRET}"}`)] });
    const result = await agent.task({ task: 'note?', output: z.object({ note: z.string() }) });
    expect(result).toMatchObject({ status: 'completed', output: { note: 'key [REDACTED:api-key]' } });
  });

  it('never truncates a structured answer: one over maxOutputChars fails without retries', async () => {
    const long = JSON.stringify({ text: 'x'.repeat(200) });
    const { agent, provider } = setup({ turns: [textTurn(long), textTurn(long)], guardrails: { builtins: { 'loop-guard': { maxOutputChars: 50 } } } });
    const result = await agent.task({ task: 'json', output: z.object({ text: z.string() }) });
    expect(provider.requests).toHaveLength(1);
    expect(result.status).toBe('failed');
    expect(result.failure).toMatch(/output_too_long/);
  });

  it('explains output_invalid when the turn limit ends the retries', async () => {
    const { agent, provider } = setup({ turns: [textTurn('nope'), textTurn('still no'), textTurn('never')] });
    const result = await agent.task({ task: 'json', output: z.object({ ok: z.boolean() }), limits: { maxTurns: 2 } });
    expect(provider.requests).toHaveLength(2);
    expect(result).toMatchObject({ status: 'failed', failure: expect.stringMatching(/output_invalid/) });
  });
});
