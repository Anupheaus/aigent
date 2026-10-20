import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMathRandom, createTimerSleeper } from './runtime-services.js';

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
