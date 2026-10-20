import type { CacheHit, CacheLookup, ToolCache } from '../cache/cache-types.js';
import { raceSignal } from '../core/race-signal.js';

const LOOKUP_TIMED_OUT = Symbol('lookup-timed-out');

/** A hit, a miss (`hit` absent: run the call) or the run's signal aborting first. */
export type BoundedLookupResult = { isAborted: true } | { isAborted: false; hit?: CacheHit };

export interface BoundedLookupParams {
  cache: ToolCache;
  lookup: CacheLookup;
}

/**
 * `cache.lookup` (which may compute a validity token and wait on another caller's flight) bounded by the run's signal
 * and the tool's own timeout. A lookup that fails or takes longer than the tool may only costs the cache: the call runs
 * uncached. A lookup that loses the race may still make this call a flight's owner later, so that flight is released
 * as soon as it resolves, and identical calls waiting on it run themselves instead of hanging.
 */
export async function boundedLookup(params: BoundedLookupParams): Promise<BoundedLookupResult> {
  const { cache, lookup } = params;
  const { tool: { timeoutMs }, context: { signal } } = lookup;
  let isAbandoned = false;
  const work = cache.lookup(lookup).catch(() => undefined);
  void work.then(hit => { if (isAbandoned && hit == null) cache.abandon(lookup); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof LOOKUP_TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(LOOKUP_TIMED_OUT), timeoutMs); });
  const race = await raceSignal({ work: Promise.race([work, timedOut]), signal }).finally(() => clearTimeout(timer));
  if (race.isAborted) { isAbandoned = true; return { isAborted: true }; }
  const { value } = race;
  if (value === LOOKUP_TIMED_OUT) { isAbandoned = true; return { isAborted: false }; }
  return value == null ? { isAborted: false } : { isAborted: false, hit: value };
}
