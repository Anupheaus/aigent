import { describe, expect, it } from 'vitest';
import { normalisePath, setMetrics } from './set-metrics.js';

describe('setMetrics', () => {
  it.each([
    { predicted: ['a', 'b'], truth: ['a', 'b'], precision: 1, recall: 1, f1: 1 },
    { predicted: ['a'], truth: ['a', 'b'], precision: 1, recall: 0.5, f1: 2 / 3 },
    { predicted: ['a', 'b', 'c', 'd'], truth: ['a', 'b'], precision: 0.5, recall: 1, f1: 2 / 3 },
    { predicted: ['x'], truth: ['a'], precision: 0, recall: 0, f1: 0 },
    { predicted: [], truth: ['a'], precision: 1, recall: 0, f1: 0 },
    { predicted: [], truth: [], precision: 1, recall: 1, f1: 1 },
    { predicted: ['a', 'a', 'b'], truth: ['a', 'b'], precision: 1, recall: 1, f1: 1 },
  ])('$predicted against $truth', ({ predicted, truth, precision, recall, f1 }) => {
    const metrics = setMetrics({ predicted, truth });
    expect(metrics.precision).toBeCloseTo(precision);
    expect(metrics.recall).toBeCloseTo(recall);
    expect(metrics.f1).toBeCloseTo(f1);
  });

  it('lists false positives and misses', () => {
    expect(setMetrics({ predicted: ['a', 'x'], truth: ['a', 'b'] })).toMatchObject({ truePositives: ['a'], falsePositives: ['x'], missed: ['b'] });
  });

  it('normalises separators, leading ./ and slashes', () => {
    expect(normalisePath('.\\src\\a.ts')).toBe('src/a.ts');
    expect(normalisePath('/src//b/')).toBe('src/b');
    expect(normalisePath(' src/c.ts ')).toBe('src/c.ts');
  });
});
