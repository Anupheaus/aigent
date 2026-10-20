import { describe, expect, it } from 'vitest';
import { defineGuardrail } from './define-guardrail.js';
import type { Guardrail, GuardrailDecisionRecord } from './guardrail-types.js';
import { createGuardrailPipeline } from './pipeline.js';

const RUN = { runId: 'run_1', agentName: 'helper' };

function record(): { records: GuardrailDecisionRecord[]; onDecision(entry: GuardrailDecisionRecord): void } {
  const records: GuardrailDecisionRecord[] = [];
  return { records, onDecision: entry => { records.push(entry); } };
}

const upper = defineGuardrail({ name: 'upper', stage: 'output', check: value => ({ action: 'rewrite', value: String(value).toUpperCase(), note: 'shouted' }) });
const exclaim = defineGuardrail({ name: 'exclaim', stage: 'output', check: value => ({ action: 'rewrite', value: `${String(value)}!`, note: 'excited' }) });
const blocker = defineGuardrail({ name: 'blocker', stage: 'output', check: () => ({ action: 'block', reason: 'nope', code: 'no_go' }) });

describe('defineGuardrail', () => {
  it.each([
    ['an empty name', { name: '', stage: 'output' }, /name/],
    ['an unknown stage', { name: 'x', stage: 'later' }, /stage must be one of input, toolCall, toolResult, output, stream/],
    ['a missing check', { name: 'x', stage: 'output', check: undefined }, /check must be a function/],
  ])('rejects %s', (_label, input, message) => {
    expect(() => defineGuardrail({ check: () => ({ action: 'allow' }), ...input } as Guardrail)).toThrow(message);
  });
});

describe('guardrail pipeline', () => {
  it('runs built-ins before custom guardrails, chains rewrites in order and records each', async () => {
    const { records, onDecision } = record();
    const pipeline = createGuardrailPipeline({ builtins: [upper], custom: [exclaim], onDecision });
    expect(await pipeline.run({ stage: 'output', value: 'hi', context: RUN })).toEqual({ action: 'allow', value: 'HI!' });
    expect(records.map(({ guardrail, action, message }) => [guardrail, action, message])).toEqual([['upper', 'rewrite', 'shouted'], ['exclaim', 'rewrite', 'excited']]);
  });

  it('orders custom guardrails by order, then registration', async () => {
    const pipeline = createGuardrailPipeline({ custom: [{ ...exclaim, order: 2 }, { ...upper, order: 1 }], onDecision: () => undefined });
    expect(await pipeline.run({ stage: 'output', value: 'hi', context: RUN })).toEqual({ action: 'allow', value: 'HI!' });
  });

  it('stops at the first block, keeping the rewrites before it', async () => {
    const { records, onDecision } = record();
    const pipeline = createGuardrailPipeline({ custom: [upper, blocker, exclaim], onDecision });
    expect(await pipeline.run({ stage: 'output', value: 'hi', context: RUN })).toEqual({ action: 'block', guardrail: 'blocker', reason: 'nope', code: 'no_go', value: 'HI' });
    expect(records.map(({ guardrail }) => guardrail)).toEqual(['upper', 'blocker']);
  });

  it('runs only the guardrails of the stage, and stays synchronous when every check is', () => {
    const pipeline = createGuardrailPipeline({ custom: [upper, defineGuardrail({ name: 'calls', stage: 'toolCall', check: () => ({ action: 'allow' }) })], onDecision: () => undefined });
    expect(pipeline.has('toolCall')).toBe(true);
    expect(pipeline.has('input')).toBe(false);
    expect(pipeline.run({ stage: 'toolCall', value: { tool: 't', args: {} }, context: RUN })).toEqual({ action: 'allow', value: { tool: 't', args: {} } });
  });

  it('fails closed by default when a check throws or times out, and open (with a warning record) when configured', async () => {
    const thrower = defineGuardrail({ name: 'thrower', stage: 'output', check: () => { throw new Error('boom'); } });
    const hanger = defineGuardrail({ name: 'hanger', stage: 'output', check: () => new Promise(() => undefined) });
    const closed = record();
    expect(await createGuardrailPipeline({ custom: [thrower], onDecision: closed.onDecision }).run({ stage: 'output', value: 'x', context: RUN })).toMatchObject({ action: 'block', guardrail: 'thrower', code: 'guardrail_error' });
    expect(await createGuardrailPipeline({ custom: [hanger], timeoutMs: 20, onDecision: closed.onDecision }).run({ stage: 'output', value: 'x', context: RUN })).toMatchObject({ action: 'block', guardrail: 'hanger', code: 'guardrail_timeout' });
    expect(closed.records.map(({ action, isBlocking }) => [action, isBlocking])).toEqual([['error', true], ['error', true]]);
    const open = record();
    const openPipeline = createGuardrailPipeline({ custom: [thrower, { ...hanger, blockLevel: false }], failMode: 'open', timeoutMs: 20, onDecision: open.onDecision });
    expect(await openPipeline.run({ stage: 'output', value: 'x', context: RUN })).toEqual({ action: 'allow', value: 'x' });
    expect(open.records.map(({ guardrail, isBlocking }) => [guardrail, isBlocking])).toEqual([['thrower', false], ['hanger', false]]);
    const levelled = createGuardrailPipeline({ custom: [{ ...thrower, blockLevel: true }], failMode: 'open', onDecision: () => undefined });
    expect(await levelled.run({ stage: 'output', value: 'x', context: RUN })).toMatchObject({ action: 'block', guardrail: 'thrower' });
  });

  it('treats a malformed decision as a failing check', async () => {
    const odd = defineGuardrail({ name: 'odd', stage: 'output', check: () => ({ action: 'maybe' }) as never });
    expect(await createGuardrailPipeline({ custom: [odd], onDecision: () => undefined }).run({ stage: 'output', value: 'x', context: RUN })).toMatchObject({ action: 'block', code: 'guardrail_error' });
  });

  it('records warnings a check raises through its context', async () => {
    const { records, onDecision } = record();
    const warner = defineGuardrail({ name: 'warner', stage: 'output', check: (_value, { warn }) => { warn('looks odd'); return { action: 'allow' }; } });
    await createGuardrailPipeline({ custom: [warner], onDecision }).run({ stage: 'output', value: 'x', context: RUN });
    expect(records).toEqual([{ guardrail: 'warner', stage: 'output', action: 'warn', message: 'looks odd' }]);
  });
});
