import { benchError } from './bench-error.js';

/** A seeded pseudo-random source: the same seed always yields the same sequence (mulberry32). */
export interface Prng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both inclusive. */
  int(range: { min: number; max: number }): number;
  /** One element of a non-empty array. */
  pick<T>(values: readonly T[]): T;
  /** A shuffled copy. */
  shuffle<T>(values: readonly T[]): T[];
  /** True with probability `probability`. */
  chance(probability: number): boolean;
}

const UINT32 = 4_294_967_296;
const MULBERRY_INCREMENT = 0x6D2B79F5;

/** A fresh generator for `seed` (any integer; it is reduced to 32 bits). */
export function createPrng(seed: number): Prng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / UINT32;
  };
  const int = ({ min, max }: { min: number; max: number }): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(values: readonly T[]): T => {
    if (values.length === 0) throw benchError('prng.pick: cannot pick from an empty array; expected at least one value');
    return values[Math.floor(next() * values.length)] as T;
  };
  const shuffle = <T>(values: readonly T[]): T[] => {
    const copy = [...values];
    for (let position = copy.length - 1; position > 0; position -= 1) {
      const other = Math.floor(next() * (position + 1));
      [copy[position], copy[other]] = [copy[other] as T, copy[position] as T];
    }
    return copy;
  };
  return { next, int, pick, shuffle, chance: probability => next() < probability };
}

/** A child generator for one concern, so adding draws to one family never shifts another family's names. */
export function derivePrng(params: { seed: number; label: string }): Prng {
  const { seed, label } = params;
  let hash = seed >>> 0;
  for (const character of label) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  return createPrng(hash);
}
