import { describe, expect, it } from 'vitest';
import { normalCdf, oneSidedProportionPValue, wilsonLowerBound } from './stats.js';

/** Tolerance of the published four-decimal tables these values come from. */
const TABLE_PRECISION = 4;

describe('significance', () => {
  it('matches the standard normal table', () => {
    // Values from a printed standard normal table (Φ(z)), not computed by the code under test.
    const table: [number, number][] = [[0, 0.5], [1, 0.8413], [-1, 0.1587], [1.645, 0.95], [1.96, 0.975], [2.326, 0.99], [-2.576, 0.005], [3, 0.9987]];
    for (const [z, expected] of table) expect(normalCdf(z)).toBeCloseTo(expected, TABLE_PRECISION);
  });

  it('gives the Wilson lower bound of published examples', () => {
    // Wilson 95% interval of 8 successes in 10: [0.4902, 0.9433] (Newcombe 1998, method 3).
    expect(wilsonLowerBound({ successes: 8, n: 10 })).toBeCloseTo(0.4902, TABLE_PRECISION);
    // 81 of 263: [0.2553, 0.3662] (Newcombe 1998, table I).
    expect(wilsonLowerBound({ successes: 81, n: 263 })).toBeCloseTo(0.2553, TABLE_PRECISION);
    expect(wilsonLowerBound({ successes: 0, n: 0 })).toBe(0);
  });

  it('gives the one-sided p-value of a two-proportion z-test', () => {
    // 60/100 vs 50/100: pooled p 0.55, z = 0.1 / sqrt(0.55 * 0.45 * 0.02) = 1.4213, so p = 1 - Φ(1.4213) = 0.0776.
    expect(oneSidedProportionPValue({ treatment: { successes: 60, n: 100 }, control: { successes: 50, n: 100 } })).toBeCloseTo(0.0776, 3);
    // The other direction: p = Φ(1.4213) = 0.9224.
    expect(oneSidedProportionPValue({ treatment: { successes: 50, n: 100 }, control: { successes: 60, n: 100 } })).toBeCloseTo(0.9224, 3);
    // No variance or no data: no evidence either way.
    expect(oneSidedProportionPValue({ treatment: { successes: 10, n: 10 }, control: { successes: 10, n: 10 } })).toBe(1);
    expect(oneSidedProportionPValue({ treatment: { successes: 0, n: 0 }, control: { successes: 5, n: 10 } })).toBe(1);
  });
});
