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
