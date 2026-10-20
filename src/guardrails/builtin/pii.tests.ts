import { describe, expect, it } from 'vitest';
import { PII_BENIGN, PII_SAMPLES } from '../fixtures.test-support.js';
import { findPii, piiGuardrails } from './pii.js';

function context(stage: 'output' | 'toolResult') {
  const warnings: string[] = [];
  return { warnings, context: { runId: 'r', agentName: 'a', stage, warn: (message: string) => { warnings.push(message); } } };
}

describe('pii detection', () => {
  it.each(PII_SAMPLES)('finds a $kind', ({ kind, text }) => {
    expect(findPii(`contact: ${text}.`).map(({ kind: found }) => found)).toEqual([kind]);
  });

  it.each(PII_BENIGN)('ignores look-alikes: %s', text => {
    expect(findPii(text)).toEqual([]);
  });

  it('warns on output by default and ignores tool results', () => {
    const [output, toolResult] = piiGuardrails({});
    const { warnings, context: outputContext } = context('output');
    expect(output!.check('mail ada.lovelace@example.org', outputContext)).toEqual({ action: 'allow' });
    expect(warnings).toEqual(['personal data in the output: email']);
    expect(toolResult).toBeUndefined();
  });

  it('redacts when configured, per stage', () => {
    const guardrails = piiGuardrails({ output: 'redact', toolResult: 'redact' });
    const output = guardrails.find(({ stage }) => stage === 'output')!;
    const toolResult = guardrails.find(({ stage }) => stage === 'toolResult')!;
    expect(output.check('call (555) 123-4567 now', context('output').context)).toEqual({ action: 'rewrite', value: 'call [REDACTED:phone] now', note: 'redacted personal data: phone' });
    expect(toolResult.check({ tool: 'crm', result: ['4111 1111 1111 1111'] }, context('toolResult').context)).toEqual({ action: 'rewrite', value: { tool: 'crm', result: ['[REDACTED:card]'] }, note: 'redacted personal data: card' });
    expect(piiGuardrails({ output: 'off' })).toEqual([]);
  });
});
