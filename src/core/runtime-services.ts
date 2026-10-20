import { randomUUID } from 'node:crypto';

/** Time source; injectable so tests get deterministic timestamps. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

/** Id source; injectable so tests get predictable ids. */
export interface IdGenerator {
  /** Returns a new unique id that starts with `prefix`. */
  next(prefix: string): string;
}

export function createSystemClock(): Clock {
  return { now: () => Date.now() };
}

export function createUuidGenerator(): IdGenerator {
  return { next: prefix => `${prefix}_${randomUUID()}` };
}

/**
 * Waits `ms` milliseconds; injectable so tests control time. Must resolve early (never reject) when `signal` aborts
 * and leave no timer or listener behind; callers check `signal.aborted` afterwards.
 */
export type Sleeper = (ms: number, signal: AbortSignal) => Promise<void>;

/** Uniform random number in [0, 1); injectable so jitter is deterministic in tests. */
export type RandomSource = () => number;

export function createTimerSleeper(): Sleeper {
  return (ms, signal) => new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createMathRandom(): RandomSource {
  return () => Math.random();
}
