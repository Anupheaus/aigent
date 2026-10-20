import { describe, expect, it } from 'vitest';
import { BENIGN_CORPUS, SECRET_SAMPLES } from '../fixtures.test-support.js';
import { findSecrets, redactSecrets, secretGuardrails } from './secrets.js';

const CONTEXT = { runId: 'r', agentName: 'a', stage: 'output' as const, warn: () => undefined };

describe('secret detection', () => {
  it.each(SECRET_SAMPLES)('redacts a $kind with its kind', ({ kind, text }) => {
    const redacted = redactSecrets(`before ${text} after`);
    expect(redacted.text).toContain(`[REDACTED:${kind}]`);
    expect(redacted.text.startsWith('before ')).toBe(true);
    expect(redacted.text.endsWith(' after')).toBe(true);
    expect(redacted.kinds).toEqual([kind]);
  });

  it('keeps the name of a key=value secret and redacts only its value', () => {
    expect(redactSecrets('password: "Tr0ub4dor&3xyz"').text).toBe('password: "[REDACTED:password]"');
  });

  it.each(BENIGN_CORPUS)('never flags ordinary text: %s', text => {
    expect(findSecrets(text)).toEqual([]);
    expect(redactSecrets(text).text).toBe(text);
  });

  it('rewrites output and tool results (walking JSON values), and allows clean ones', () => {
    const [output, toolResult] = secretGuardrails().filter(({ stage }) => stage === 'output' || stage === 'toolResult');
    expect(output!.check(`key ${SECRET_SAMPLES[0]!.text}`, CONTEXT)).toEqual({ action: 'rewrite', value: 'key [REDACTED:api-key]', note: 'redacted secrets: api-key' });
    expect(toolResult!.check({ tool: 'read', result: { rows: [{ dsn: SECRET_SAMPLES[8]!.text }] } }, { ...CONTEXT, stage: 'toolResult' })).toEqual({
      action: 'rewrite', value: { tool: 'read', result: { rows: [{ dsn: '[REDACTED:connection-string]' }] } }, note: 'redacted secrets: connection-string',
    });
    expect(output!.check('nothing here', CONTEXT)).toEqual({ action: 'allow' });
  });
});
