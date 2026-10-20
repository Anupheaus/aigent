import { describe, expect, it } from 'vitest';
import { mean, median, percentile } from './stats.js';

describe('stats', () => {
  it('takes the median of odd and even counts, and null of none', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('takes nearest-rank percentiles', () => {
    const values = Array.from({ length: 10 }, (_, index) => index + 1);
    expect(percentile({ values, fraction: 0.9 })).toBe(9);
    expect(percentile({ values: [5], fraction: 0.9 })).toBe(5);
    expect(percentile({ values: [], fraction: 0.9 })).toBeNull();
  });

  it('takes the mean, and null of none', () => {
    expect(mean([1, 2, 6])).toBe(3);
    expect(mean([])).toBeNull();
  });
});
