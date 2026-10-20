import { describe, expect, it } from 'vitest';
import { estimateTokens } from './estimate-tokens.js';

describe('estimateTokens', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['abcd', 1],
    ['abcde', 2],
    ['x'.repeat(400), 100],
  ])('estimates %j as %d tokens (characters / 4, rounded up)', (text, expected) => {
    expect(estimateTokens(text)).toBe(expected);
  });
});
