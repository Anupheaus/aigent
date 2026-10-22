import { describe, expect, it } from 'vitest';
import { checkResult } from './check-result.js';
import { specWith } from './spec.test-support.js';
import { budgetsFrom, tierOf } from './tiers.js';

describe('tiers', () => {
  const spec = specWith({ groundTruth: { kind: 'files', files: ['a'] }, budgets: budgetsFrom({ tokens: 1_000, turns: 3, toolCalls: 2, ms: 1_000 }) });
  const right = checkResult(spec, { files: ['a'] });
  const wrong = checkResult(spec, { files: ['b'] });

  it('derives budgets from the reference: pass 4x, target 1.5x up, stretch 0.8x down', () => {
    expect(spec.budgets).toEqual({
      pass: { maxTokens: 4_000, maxTurns: 12, maxToolCalls: 8, maxMs: 4_000 },
      target: { maxTokens: 1_500, maxTurns: 5, maxToolCalls: 3, maxMs: 1_500 },
      stretch: { maxTokens: 800, maxTurns: 2, maxToolCalls: 1, maxMs: 800 },
    });
  });

  it.each([
    { usage: { tokens: 700, turns: 2, toolCalls: 1, ms: 10 }, tier: 'stretch' },
    { usage: { tokens: 1_000, turns: 3, toolCalls: 2, ms: 10 }, tier: 'target' },
    { usage: { tokens: 3_000, turns: 3, toolCalls: 2, ms: 10 }, tier: 'pass' },
    { usage: { tokens: 3_000, turns: 13, toolCalls: 2, ms: 10 }, tier: 'over-budget' },
  ])('places a correct run using $usage at $tier', ({ usage, tier }) => {
    expect(tierOf({ spec, check: right, usage })).toBe(tier);
  });

  it('fails a wrong answer however cheap it was', () => {
    expect(tierOf({ spec, check: wrong, usage: { tokens: 1, turns: 1, toolCalls: 0, ms: 1 } })).toBe('fail');
  });
});
