import type { ProviderEvent } from '../providers/provider-types.js';
import { createAigentError, isAigentError } from './aigent-error.js';
import type { AigentError } from './aigent-error.js';
import { describeError } from './describe-value.js';
import { withFirstEventTimeout } from './first-event-timeout.js';
import { openStreamIterator } from './open-stream-iterator.js';
import { raceSignal } from './race-signal.js';
import type { SignalRace } from './race-signal.js';
import { computeBackoffMs, isRetryable, retryAfterMsOf } from './resilience-policy.js';
import type { ResiliencePolicy } from './resilience-policy.js';
import type { RandomSource, Sleeper } from './runtime-services.js';
import { stopStream } from './stop-stream.js';

/** One model to try: the primary first, then each fallback. */
export interface ProviderAttempt {
  /** `provider:model`, for events and errors. */
  label: string;
  /** Starts a fresh stream; called again for each retry. */
  open(signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export interface RetryInfo {
  /** 1 for the first retry of this attempt. */
  attempt: number;
  delayMs: number;
  label: string;
  /** The failure's message. */
  reason: string;
  error: unknown;
}

export interface FallbackInfo {
  from: string;
  to: string;
  /** The message of the failure that ended `from`. */
  reason: string;
  error: unknown;
}

export interface ResilientStreamParams {
  /** Primary first, then fallbacks in order. */
  attempts: [ProviderAttempt, ...ProviderAttempt[]];
  policy: ResiliencePolicy;
  sleep: Sleeper;
  random: RandomSource;
  signal: AbortSignal;
  onRetry?(info: RetryInfo): void;
  onFallback?(info: FallbackInfo): void;
  /** Overrides `policy.firstEventTimeoutMs`. */
  firstEventTimeoutMs?: number;
}

type AttemptOutcome = { kind: 'completed' } | { kind: 'failed'; error: unknown };

interface StreamAttemptParams {
  attempt: ProviderAttempt;
  signal: AbortSignal;
  sleep: Sleeper;
  firstEventTimeoutMs?: number;
}

function abortedError(label: string): AigentError {
  return createAigentError({ code: 'aborted', message: `Provider stream '${label}' was aborted` });
}

function isProviderFailure(error: unknown): boolean {
  return isAigentError(error) && error.code === 'provider_failed';
}

/**
 * Streams one attempt. A failure before the first event is returned (so the caller may retry); once an event has
 * been yielded any failure is thrown, since replaying would duplicate what the consumer already saw. Each `next()`
 * races the signal, so an abort settles at once even if the stream ignores it; an abandoned stream is told to return.
 */
async function* streamAttempt(params: StreamAttemptParams): AsyncGenerator<ProviderEvent, AttemptOutcome> {
  const { attempt: { label, open }, signal, sleep, firstEventTimeoutMs } = params;
  let iterator: AsyncIterator<ProviderEvent>;
  try {
    // A provider that throws while opening failed before any event, so the failure is retryable like any other.
    iterator = firstEventTimeoutMs == null
      ? openStreamIterator({ open, signal, label })
      : withFirstEventTimeout({ open, signal, timeoutMs: firstEventTimeoutMs, sleep, label })[Symbol.asyncIterator]();
  } catch (error) {
    if (signal.aborted) throw abortedError(label);
    return { kind: 'failed', error };
  }
  let hasYielded = false;
  let isSettled = false;
  try {
    for (;;) {
      let raced: SignalRace<IteratorResult<ProviderEvent>>;
      try {
        raced = await raceSignal({ work: iterator.next(), signal });
      } catch (error) {
        isSettled = true;
        if (signal.aborted) throw abortedError(label);
        if (hasYielded) throw error;
        return { kind: 'failed', error };
      }
      if (raced.isAborted) throw abortedError(label);
      if (raced.value.done === true) { isSettled = true; return { kind: 'completed' }; }
      hasYielded = true;
      yield raced.value.value;
    }
  } finally {
    if (!isSettled) stopStream(iterator);
  }
}

/**
 * Streams from the first attempt that works. Retryable failures before any event are retried with backoff (up to
 * `maxRetries` per attempt, and never when the server's `retry-after` exceeds `maxDelayMs`); then, for `provider_failed` errors that are retryable (or any, with
 * `fallbackOnNonRetryable`), the next attempt is tried. A failure after an event was yielded is thrown at once.
 * An abort at any point (streaming, opening, backing off) throws `aborted` promptly.
 */
export async function* streamWithResilience(params: ResilientStreamParams): AsyncGenerator<ProviderEvent> {
  const { attempts, policy, sleep, random, signal, onRetry, onFallback } = params;
  const firstEventTimeoutMs = params.firstEventTimeoutMs ?? policy.firstEventTimeoutMs;
  for (const [index, attempt] of attempts.entries()) {
    const { label } = attempt;
    for (let retry = 0; ; retry += 1) {
      if (signal.aborted) throw abortedError(label);
      const outcome = yield* streamAttempt({ attempt, signal, sleep, firstEventTimeoutMs });
      if (outcome.kind === 'completed') return;
      const { error } = outcome;
      const retryAfterMs = retryAfterMsOf(error);
      // A server asking for a longer wait than the policy allows (a spent quota, typically) is not waited for: the
      // run moves on to its fallback, or fails, rather than sleeping silently for an hour.
      const isWaitTooLong = retryAfterMs != null && retryAfterMs > policy.maxDelayMs;
      const reason = isWaitTooLong
        ? `${describeError(error)} (retry-after ${retryAfterMs} ms is longer than maxDelayMs ${policy.maxDelayMs} ms, so it was not waited for)`
        : describeError(error);
      if (isRetryable(error) && retry < policy.maxRetries && !isWaitTooLong) {
        const delayMs = computeBackoffMs({ attempt: retry, policy, retryAfterMs, random });
        onRetry?.({ attempt: retry + 1, delayMs, label, reason, error });
        await sleep(delayMs, signal);
        continue;
      }
      const next = attempts[index + 1];
      const canFallBack = isProviderFailure(error) && (isRetryable(error) || policy.fallbackOnNonRetryable);
      if (next == null || !canFallBack) throw error;
      onFallback?.({ from: label, to: next.label, reason, error });
      break;
    }
  }
}
