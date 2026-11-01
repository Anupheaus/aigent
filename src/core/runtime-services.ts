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

/** `createTimerSleeper` options. */
export interface TimerSleeperOptions {
  /** The timers do not keep the process alive (background work such as lease heartbeats). */
  unref?: boolean;
}

export function createTimerSleeper(options: TimerSleeperOptions = {}): Sleeper {
  const { unref = false } = options;
  return (ms, signal) => new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    // Outside Node (e.g. browsers) a timer is a number without unref.
    if (unref && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createMathRandom(): RandomSource {
  return () => Math.random();
}

/** mulberry32 increment and output-mixing constants. */
const MULBERRY_INCREMENT = 0x6d_2b_79_f5;
const MULBERRY_MIX_A = 0x85_eb_ca_6b;
const MULBERRY_MIX_B = 0xc2_b2_ae_35;
const UINT32_RANGE = 4_294_967_296;

/** A reproducible uniform source in [0, 1) (mulberry32): the same seed always gives the same sequence. */
export function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    mixed = Math.imul(mixed ^ (mixed >>> 13), MULBERRY_MIX_A) ^ Math.imul(mixed ^ (mixed >>> 16), MULBERRY_MIX_B);
    return ((mixed ^ (mixed >>> 16)) >>> 0) / UINT32_RANGE;
  };
}
