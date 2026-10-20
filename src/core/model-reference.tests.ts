import { describe, expect, it } from 'vitest';
import { parseModelReference } from './model-reference.js';

describe('parseModelReference', () => {
  it('splits provider:model', () => {
    expect(parseModelReference('anthropic:claude-sonnet-5-5')).toEqual({ providerId: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  it('splits at the first colon only, so model ids may contain colons', () => {
    expect(parseModelReference('ollama:qwen2.5:14b')).toEqual({ providerId: 'ollama', model: 'qwen2.5:14b' });
  });

  it.each(['no-colon', ':model', 'provider:', ''])('rejects %j as invalid_definition naming the value and the expected form', reference => {
    expect(() => parseModelReference(reference)).toThrow(expect.objectContaining({
      code: 'invalid_definition',
      message: `Model '${reference}' must be in the form provider:model, e.g. 'anthropic:claude-sonnet-5-5'`,
      details: { model: reference },
    }));
  });
});
