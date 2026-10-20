import { describe, expect, it } from 'vitest';
import { MIN_HOLD_BACK_CHARS, parseGuardrailOptions } from './guardrail-options.js';

describe('guardrail options', () => {
  it('refuses a secrets hold-back shorter than the longest secret prefix it must hold whole', () => {
    expect(() => parseGuardrailOptions({ builtins: { secrets: { holdBackChars: 4 } } })).toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringMatching(new RegExp(`holdBackChars.*${MIN_HOLD_BACK_CHARS}`)) }));
    expect(parseGuardrailOptions({ builtins: { secrets: { holdBackChars: MIN_HOLD_BACK_CHARS } } })).toMatchObject({ builtins: { secrets: { holdBackChars: MIN_HOLD_BACK_CHARS } } });
  });
});
