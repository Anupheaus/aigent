import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMathRandom, createSeededRandom, createTimerSleeper } from './runtime-services.js';

describe('createTimerSleeper', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('resolves after the delay and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const sleep = createTimerSleeper();
    let isDone = false;
    const slept = sleep(1_000, new AbortController().signal).then(() => { isDone = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(isDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await slept;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves at once when aborted, clearing its timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const slept = createTimerSleeper()(60_000, controller.signal);
    controller.abort();
    await slept;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves immediately for an already aborted signal without starting a timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    await createTimerSleeper()(60_000, controller.signal);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createMathRandom', () => {
  it('returns numbers in [0, 1)', () => {
    const random = createMathRandom();
    for (let draw = 0; draw < 100; draw += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('createSeededRandom', () => {
  it('repeats its sequence for the same seed and differs for another', () => {
    const draws = (seed: number): number[] => { const random = createSeededRandom(seed); return Array.from({ length: 5 }, () => random()); };
    expect(draws(7)).toEqual(draws(7));
    expect(draws(7)).not.toEqual(draws(8));
  });

  it('stays in [0, 1) and is roughly uniform', () => {
    const random = createSeededRandom(42);
    const values = Array.from({ length: 10_000 }, () => random());
    expect(values.every(value => value >= 0 && value < 1)).toBe(true);
    const average = values.reduce((total, value) => total + value, 0) / values.length;
    // Standard error of the mean of 10,000 uniforms is about 0.003, so 0.02 is far outside chance.
    expect(Math.abs(average - 0.5)).toBeLessThan(0.02);
  });
});
