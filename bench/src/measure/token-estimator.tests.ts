import { describe, expect, it } from 'vitest';
import { estimateTokens as libraryEstimate } from '../../../src/telemetry/estimate-tokens.js';
import { estimateTokens, requestTokens } from './token-estimator.js';

describe('token estimator', () => {
  it('is the library estimator: ceil(chars / 4)', () => {
    for (const text of ['', 'a', 'abcd', 'abcde', 'x'.repeat(1_001)]) expect(estimateTokens(text)).toBe(libraryEstimate(text));
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('counts a request as its serialised messages plus its tool schemas', () => {
    const request = { messages: [{ role: 'user', text: 'hi' }], tools: [{ name: 'fs_read' }] };
    expect(requestTokens(request)).toBe(estimateTokens(JSON.stringify(request.messages)) + estimateTokens(JSON.stringify(request.tools)));
  });
});
