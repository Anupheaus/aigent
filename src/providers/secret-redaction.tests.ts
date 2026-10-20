import { describe, expect, it } from 'vitest';
import { createAigentError, isAigentError } from '../core/aigent-error.js';
import type { ProviderEvent } from './provider-types.js';
import { collectSecrets, redactingErrors, redactSecrets } from './secret-redaction.js';

const TOKEN = 'sk-token-value-123';

describe('collectSecrets', () => {
  it('takes credential header values, including the bare token of a bearer header, longest first', () => {
    expect(collectSecrets({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-api-key': 'ant-key-value-9' }))
      .toEqual([`Bearer ${TOKEN}`, TOKEN, 'ant-key-value-9']);
  });

  it('ignores values too short to be real keys, so placeholders do not mangle messages', () => {
    expect(collectSecrets({ authorization: 'Bearer x', 'api-key': 'ollama' })).toEqual([]);
  });
});

describe('redactSecrets', () => {
  it('replaces every occurrence of every secret', () => {
    expect(redactSecrets({ text: `${TOKEN} and ${TOKEN}`, secrets: [TOKEN] })).toBe('[REDACTED] and [REDACTED]');
  });
});

describe('redactingErrors', () => {
  it('passes events through and redacts the message and string details of a thrown AigentError', async () => {
    async function* failing(): AsyncGenerator<ProviderEvent> {
      yield { type: 'text-delta', text: 'hi' };
      throw createAigentError({ code: 'provider_failed', message: `bad key ${TOKEN}`, details: { body: TOKEN, status: 401 } });
    }
    const seen: ProviderEvent[] = [];
    let caught: unknown;
    try {
      for await (const event of redactingErrors({ events: failing(), secrets: [TOKEN] })) seen.push(event);
    } catch (error) {
      caught = error;
    }
    expect(seen).toEqual([{ type: 'text-delta', text: 'hi' }]);
    expect(isAigentError(caught)).toBe(true);
    expect(caught).toMatchObject({ code: 'provider_failed', message: 'bad key [REDACTED]', details: { body: '[REDACTED]', status: 401 } });
  });
});
