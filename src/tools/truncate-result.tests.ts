import { describe, expect, it } from 'vitest';
import { truncateResult } from './truncate-result.js';

describe('truncateResult', () => {
  it('measures the serialised result and leaves it untouched without a budget', () => {
    const result = { a: 'x' };
    const sized = truncateResult({ result });
    expect(sized.result).toBe(result);
    expect(sized.size).toEqual({ resultBytes: 9, resultTokens: 3, truncated: false });
  });

  it('counts bytes as UTF-8 and tokens from characters', () => {
    expect(truncateResult({ result: 'é' }).size).toEqual({ resultBytes: 4, resultTokens: 1, truncated: false });
  });

  it('leaves a result within its budget untouched', () => {
    const result = 'abc';
    expect(truncateResult({ result, maxResultTokens: 2 })).toEqual({ result, size: { resultBytes: 5, resultTokens: 2, truncated: false } });
  });

  it('replaces an oversize result by the marker, keeping the original size', () => {
    const sized = truncateResult({ result: 'abcdefghijklmnopqrstuvwxyz', maxResultTokens: 2 });
    expect(sized.result).toEqual({
      truncated: true,
      note: 'Result truncated to ~2 tokens (was ~7); narrow the request or page through it.',
      preview: '"abcdefg',
    });
    expect(sized.size).toEqual({ resultBytes: 28, resultTokens: 7, truncated: true });
  });

  it('treats an undefined result as empty text', () => {
    expect(truncateResult({ result: undefined, maxResultTokens: 1 })).toEqual({ result: undefined, size: { resultBytes: 0, resultTokens: 0, truncated: false } });
  });

  it('measures results JSON cannot serialise without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(truncateResult({ result: circular }).size.resultBytes).toBeGreaterThan(0);
    expect(truncateResult({ result: 10n }).size).toEqual({ resultBytes: 2, resultTokens: 1, truncated: false });
  });
});
