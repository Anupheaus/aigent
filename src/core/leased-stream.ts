import type { ProviderEvent } from '../providers/provider-types.js';
import type { LeaseRequest, QueuedInfo, Scheduler } from '../scheduler/scheduler-types.js';
import { createAigentError, isAigentError } from './aigent-error.js';
import { withFirstEventTimeout } from './first-event-timeout.js';
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
  const { scheduler, lease: leaseRequest, open, signal, onQueued, firstEventTimeoutMs, sleep } = params;
  const { key } = leaseRequest;
  const lease = await scheduler.acquire({ ...leaseRequest, signal, onQueued });
  let usedTokens: number | undefined;
  const events = firstEventTimeoutMs == null ? open(signal) : withFirstEventTimeout({ open, signal, timeoutMs: firstEventTimeoutMs, sleep, label: key });
  const iterator = events[Symbol.asyncIterator]();
  let isSettled = false;
  try {
    for (;;) {
      const raced = await raceSignal({ work: iterator.next(), signal }).catch((error: unknown) => {
        isSettled = true;
        if (isRateLimited(error)) scheduler.reportRateLimit({ key, retryAfterMs: retryAfterMsOf(error) ?? DEFAULT_RATE_LIMIT_PAUSE_MS });
        throw error;
      });
      if (raced.isAborted) throw createAigentError({ code: 'aborted', message: `Provider stream '${key}' was aborted` });
      if (raced.value.done === true) { isSettled = true; return; }
      const event = raced.value.value;
      if (event.type === 'usage') usedTokens = event.usage.inputTokens + event.usage.outputTokens;
      yield event;
    }
  } finally {
    if (!isSettled) stopStream(iterator);
    lease.release(usedTokens == null ? undefined : { tokens: usedTokens });
  }
}
