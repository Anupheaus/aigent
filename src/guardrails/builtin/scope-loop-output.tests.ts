import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { GuardrailStage } from '../guardrail-types.js';
import { loopGuardrails } from './loop-guard.js';
import { outputSchemaGuardrails, parseStructuredOutput } from './output-schema.js';
import { scopeGuardrails } from './scope.js';

function context(stage: GuardrailStage) {
  const warnings: string[] = [];
  return { warnings, context: { runId: 'r', agentName: 'a', stage, warn: (message: string) => { warnings.push(message); } } };
}

describe('scope guardrail', () => {
  it('blocks denied tools, tools outside an allow list and tools the task put out of scope', () => {
    const [call] = scopeGuardrails({ options: { denyTools: ['drop_table'], allowTools: ['read', 'drop_table', 'send_email'] }, run: { outOfScope: ['send_email', 'Billing changes'] } });
    const { context: callContext } = context('toolCall');
    expect(call!.check({ tool: 'read', args: {} }, callContext)).toEqual({ action: 'allow' });
    expect(call!.check({ tool: 'drop_table', args: {} }, callContext)).toMatchObject({ action: 'block', code: 'tool_out_of_scope', reason: expect.stringMatching(/'drop_table' is denied/) });
    expect(call!.check({ tool: 'write', args: {} }, callContext)).toMatchObject({ action: 'block', reason: expect.stringMatching(/'write' is not among the allowed tools: read, drop_table, send_email/) });
    expect(call!.check({ tool: 'send_email', args: {} }, callContext)).toMatchObject({ action: 'block', reason: expect.stringMatching(/out of scope for this task/) });
  });

  it('warns when the output mentions a forbidden term', () => {
    const output = scopeGuardrails({ options: { forbiddenTerms: ['Project X'] }, run: {} }).find(({ stage }) => stage === 'output')!;
    const { warnings, context: outputContext } = context('output');
    expect(output.check('About project x: it is fine.', outputContext)).toEqual({ action: 'allow' });
    expect(warnings).toEqual(["the output mentions the forbidden term 'Project X'"]);
  });
});

describe('loop guard', () => {
  it('blocks the fourth identical call of a run (key order does not matter) and lets different ones through', () => {
    const [call] = loopGuardrails({});
    const { context: callContext } = context('toolCall');
    for (let attempt = 0; attempt < 3; attempt += 1) expect(call!.check({ tool: 'find', args: { a: 1, b: 2 } }, callContext)).toEqual({ action: 'allow' });
    expect(call!.check({ tool: 'find', args: { b: 2, a: 1 } }, callContext)).toMatchObject({ action: 'block', code: 'repeated_call', reason: expect.stringMatching(/'find' was already called 3 times with these arguments/) });
    expect(call!.check({ tool: 'find', args: { a: 2 } }, callContext)).toEqual({ action: 'allow' });
  });

  it('truncates a runaway answer with a note', () => {
    const output = loopGuardrails({ maxOutputChars: 10 }).find(({ stage }) => stage === 'output')!;
    expect(output.check('0123456789abc', context('output').context)).toEqual({ action: 'rewrite', value: '0123456789\n[answer truncated at 10 characters]', note: 'the answer was 13 characters, over maxOutputChars 10' });
  });
});

describe('output schema guardrail', () => {
  const schema = z.object({ city: z.string(), population: z.number() }).strict();

  it('parses JSON answers (code fences allowed) and blocks invalid ones with the issues', () => {
    expect(parseStructuredOutput({ text: '```json\n{"city":"Oslo","population":700000}\n```', schema, format: 'json' })).toEqual({ ok: true, value: { city: 'Oslo', population: 700_000 } });
    const [output] = outputSchemaGuardrails({ output: schema });
    expect(output!.check('{"city":"Oslo"}', context('output').context)).toMatchObject({ action: 'block', code: 'output_invalid', reason: expect.stringMatching(/population/) });
    expect(output!.check('not json', context('output').context)).toMatchObject({ action: 'block', code: 'output_invalid', reason: expect.stringMatching(/not valid JSON/) });
    expect(outputSchemaGuardrails({})).toEqual([]);
  });

  it('validates the text itself with outputFormat text', () => {
    expect(parseStructuredOutput({ text: 'ABC-123', schema: z.string().regex(/^[A-Z]+-\d+$/), format: 'text' })).toEqual({ ok: true, value: 'ABC-123' });
  });
});
