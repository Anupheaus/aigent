import { describe, expect, it } from 'vitest';
import { createPrng, derivePrng } from './prng.js';

const draws = (seed: number, count: number): number[] => {
  const prng = createPrng(seed);
  return Array.from({ length: count }, () => prng.next());
};

describe('prng', () => {
  it('repeats the same sequence for the same seed and differs for another seed', () => {
    expect(draws(7, 20)).toEqual(draws(7, 20));
    expect(draws(7, 20)).not.toEqual(draws(8, 20));
    expect(draws(7, 200).every(value => value >= 0 && value < 1)).toBe(true);
  });

  it('keeps int within its inclusive range, and picks and shuffles deterministically', () => {
    const prng = createPrng(3);
    const ints = Array.from({ length: 500 }, () => prng.int({ min: 2, max: 5 }));
    expect(new Set(ints)).toEqual(new Set([2, 3, 4, 5]));
    const values = ['a', 'b', 'c', 'd', 'e'];
    expect(createPrng(9).shuffle(values)).toEqual(createPrng(9).shuffle(values));
    expect([...createPrng(9).shuffle(values)].sort()).toEqual(values);
    expect(createPrng(1).pick(values)).toBe(createPrng(1).pick(values));
    expect(() => createPrng(1).pick([])).toThrow(/empty/);
  });

  it('derives independent streams per label, stable for a seed', () => {
    const first = derivePrng({ seed: 1, label: 'theme' }).next();
    expect(derivePrng({ seed: 1, label: 'theme' }).next()).toBe(first);
    expect(derivePrng({ seed: 1, label: 'react' }).next()).not.toBe(first);
    expect(derivePrng({ seed: 2, label: 'theme' }).next()).not.toBe(first);
  });
});
