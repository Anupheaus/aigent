import { describe, expect, it } from 'vitest';
import { fixtureRun } from './fixtures.test-support.js';
import { costOfRun, parsePricing } from './pricing.js';

describe('costOfRun', () => {
  const pricing = { 'fake:m': { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cachedInputPerMTokUsd: 0.3 } };

  it('prices uncached input, cached input and output separately', () => {
    const run = fixtureRun({ startedAt: 1, inputTokens: 1_000_000, cachedTokens: 400_000, outputTokens: 100_000 });
    expect(costOfRun({ run, pricing })).toBeCloseTo(0.6 * 3 + 0.4 * 0.3 + 0.1 * 15, 10);
  });

  it('charges cached input at the input price when no cached price is set', () => {
    const run = fixtureRun({ startedAt: 1, inputTokens: 1_000_000, cachedTokens: 1_000_000 });
    expect(costOfRun({ run, pricing: { 'fake:m': { inputPerMTokUsd: 2, outputPerMTokUsd: 4 } } })).toBe(2);
  });

  it('is null without pricing for the model', () => {
    expect(costOfRun({ run: fixtureRun({ startedAt: 1, model: 'other:m' }), pricing })).toBeNull();
    expect(costOfRun({ run: fixtureRun({ startedAt: 1 }) })).toBeNull();
  });
});

describe('parsePricing', () => {
  it('accepts prices keyed provider:model', () => {
    expect(parsePricing({ 'anthropic:claude': { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } })).toEqual({ 'anthropic:claude': { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } });
    expect(parsePricing(undefined)).toBeUndefined();
  });

  it.each([
    [{ 'anthropic:claude': { inputPerMTokUsd: -1, outputPerMTokUsd: 1 } }, 'inputPerMTokUsd'],
    [{ 'anthropic:claude': { inputPerMTokUsd: 1 } }, 'outputPerMTokUsd'],
    [{ claude: { inputPerMTokUsd: 1, outputPerMTokUsd: 1 } }, 'provider:model'],
    [{ 'anthropic:claude': { inputPerMTokUsd: 1, outputPerMTokUsd: 1, perCall: 1 } }, 'perCall'],
  ])('rejects %j with invalid_definition naming %s', (pricing, mentioned) => {
    expect(() => parsePricing(pricing)).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringContaining(mentioned) }));
  });
});
