import type { ProviderEvent } from '../providers/provider-types.js';
import type { LeaseRequest, QueuedInfo, Scheduler } from '../scheduler/scheduler-types.js';
import { createAigentError, isAigentError } from './aigent-error.js';
import { withFirstEventTimeout } from './first-event-timeout.js';
import { openStreamIterator } from './open-stream-iterator.js';
import { raceSignal } from './race-signal.js';
import { retryAfterMsOf } from './resilience-policy.js';
import type { Sleeper } from './runtime-services.js';
import { stopStream } from './stop-stream.js';

export interface LeasedStreamParams {
  scheduler: Scheduler;
  /** Everything but the signal and queue callback. */
  lease: Omit<LeaseRequest, 'signal' | 'onQueued'>;
  open(signal: AbortSignal): AsyncIterable<ProviderEvent>;
  signal: AbortSignal;
  onQueued(info: QueuedInfo): void;
  /** Applied once the lease is granted, so time spent queued never counts. */
  firstEventTimeoutMs?: number;
  /** See `FirstEventTimeoutParams.hasStarted`. */
  hasStarted?(): boolean;
  /** Longest pause a 429 may put on the key (default: the server's `retry-after`, uncapped). */
  maxRateLimitPauseMs?: number;
  sleep: Sleeper;
}

const RATE_LIMITED_STATUS = 429;
/** Pause applied when a 429 arrives without a usable `retry-after`. */
const DEFAULT_RATE_LIMIT_PAUSE_MS = 1_000;

function isRateLimited(error: unknown): boolean {
  return isAigentError(error) && error.code === 'provider_failed' && error.details?.status === RATE_LIMITED_STATUS;
}

/**
 * Waits for a scheduler lease, then streams the provider call, releasing the lease (with the actual token usage) as
 * soon as the stream ends, fails, aborts or is abandoned. A 429 pauses the key in the scheduler. Each read races the
 * signal, so even a provider that ignores aborts cannot hold the lease after the run is stopped.
 */
export async function* leasedStream(params: LeasedStreamParams): AsyncGenerator<ProviderEvent> {
  const { scheduler, lease: leaseRequest, open, signal, onQueued, firstEventTimeoutMs, hasStarted, maxRateLimitPauseMs = Number.POSITIVE_INFINITY, sleep } = params;
  const { key } = leaseRequest;
  const lease = await scheduler.acquire({ ...leaseRequest, signal, onQueued });
  let usedTokens: number | undefined;
  let iterator: AsyncIterator<ProviderEvent> | undefined;
  let isSettled = false;
  /** The stream failed by itself (opening or reading), so there is nothing to stop; a 429 also pauses the key. */
  const fail = (error: unknown): never => {
    isSettled = true;
    // Capped: the pause stalls every agent on the key, and a run never waits longer than its policy allows anyway.
    if (isRateLimited(error)) scheduler.reportRateLimit({ key, retryAfterMs: Math.min(retryAfterMsOf(error) ?? DEFAULT_RATE_LIMIT_PAUSE_MS, maxRateLimitPauseMs) });
    throw error;
  };
  const openOrFail = (): AsyncIterator<ProviderEvent> => {
    try {
      return firstEventTimeoutMs == null
        ? openStreamIterator({ open, signal, label: key })
        : withFirstEventTimeout({ open, signal, timeoutMs: firstEventTimeoutMs, sleep, label: key, ...(hasStarted == null ? {} : { hasStarted }) })[Symbol.asyncIterator]();
    } catch (error) {
      return fail(error);
    }
  };
  // Everything after the lease is granted, opening included, is inside the try: a provider may throw synchronously.
  try {
    const opened = openOrFail();
    iterator = opened;
    for (;;) {
      const raced = await raceSignal({ work: opened.next(), signal }).catch(fail);
      if (raced.isAborted) throw createAigentError({ code: 'aborted', message: `Provider stream '${key}' was aborted` });
      if (raced.value.done === true) { isSettled = true; return; }
      const event = raced.value.value;
      if (event.type === 'usage') usedTokens = event.usage.inputTokens + event.usage.outputTokens;
      yield event;
    }
  } finally {
    if (!isSettled && iterator != null) stopStream(iterator);
    lease.release(usedTokens == null ? undefined : { tokens: usedTokens });
  }
}
