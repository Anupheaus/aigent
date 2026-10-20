import type { QueuedRequest } from './pick-next-waiter.js';
import type { Lease, LeaseRequest, ProviderLimits, QueueReason } from './scheduler-types.js';
import { createTokenBucket } from './token-bucket.js';
import type { TokenBucket } from './token-bucket.js';

/** Per-minute budgets are measured over this sliding window. */
const WINDOW_MS = 60_000;
/** Each admission takes one request from the requests-per-minute budget. */
const REQUEST_COST = 1;

/** A request waiting for admission. */
export interface Waiter extends QueuedRequest {
  request: LeaseRequest;
  resolve(lease: Lease): void;
  /** Stops listening for the request's abort. */
  detach(): void;
}

/** Everything the scheduler tracks for one limit key. */
export interface KeyState {
  limits: ProviderLimits;
  inFlight: number;
  requestBudget?: TokenBucket;
  tokenBudget?: TokenBucket;
  /** No admissions before this time (ms since the epoch); set by a 429. */
  pausedUntil: number;
  /** Admissions left at half concurrency after a 429. */
  halvedAdmissionsLeft: number;
  /** In arrival order. */
  waiters: Waiter[];
  /** Admission counter value when each agent was last admitted. */
  lastServed: Map<string, number>;
  /** Aborts the pending wake-up timer, when one is armed. */
  wakeTimer?: AbortController;
}

/** Why a request cannot be admitted now, and for how long when that is known. */
export interface AdmissionBlock {
  reason: QueueReason;
  waitMs?: number;
}

export interface BlockForParams {
  state: KeyState;
  estimatedTokens: number;
  now: number;
}

export function createKeyState(limits: ProviderLimits): KeyState {
  const { requestsPerMinute, tokensPerMinute } = limits;
  return {
    limits,
    inFlight: 0,
    ...(requestsPerMinute == null ? {} : { requestBudget: createTokenBucket({ capacity: requestsPerMinute, windowMs: WINDOW_MS }) }),
    ...(tokensPerMinute == null ? {} : { tokenBudget: createTokenBucket({ capacity: tokensPerMinute, windowMs: WINDOW_MS }) }),
    pausedUntil: 0,
    halvedAdmissionsLeft: 0,
    waiters: [],
    lastServed: new Map(),
  };
}

/** `maxConcurrent`, halved (at least 1) while recovering from a 429; undefined when unlimited. */
function effectiveMaxConcurrent(state: KeyState): number | undefined {
  const { limits: { maxConcurrent }, halvedAdmissionsLeft } = state;
  if (maxConcurrent == null) return undefined;
  return halvedAdmissionsLeft > 0 ? Math.max(1, Math.floor(maxConcurrent / 2)) : maxConcurrent;
}

/** Undefined when a request of `estimatedTokens` may start now. */
export function blockFor(params: BlockForParams): AdmissionBlock | undefined {
  const { state, estimatedTokens, now } = params;
  const { inFlight, pausedUntil, requestBudget, tokenBudget } = state;
  // A rate-limit pause is the provider saying "too many requests", so it is reported as the request budget.
  if (now < pausedUntil) return { reason: 'requests-per-minute', waitMs: pausedUntil - now };
  const maxConcurrent = effectiveMaxConcurrent(state);
  if (maxConcurrent != null && inFlight >= maxConcurrent) return { reason: 'concurrency' };
  if (requestBudget != null && !requestBudget.canSpend({ amount: REQUEST_COST, now })) {
    return { reason: 'requests-per-minute', waitMs: requestBudget.waitMs({ amount: REQUEST_COST, now }) };
  }
  if (tokenBudget != null && !tokenBudget.canSpend({ amount: estimatedTokens, now })) {
    return { reason: 'tokens-per-minute', waitMs: tokenBudget.waitMs({ amount: estimatedTokens, now }) };
  }
  return undefined;
}

/** Takes one admission's share of every budget; returns a function that corrects the token estimate. */
export function chargeAdmission(params: BlockForParams): (actualTokens: number) => void {
  const { state, estimatedTokens, now } = params;
  state.inFlight += 1;
  if (state.halvedAdmissionsLeft > 0) state.halvedAdmissionsLeft -= 1;
  state.requestBudget?.spend({ amount: REQUEST_COST, now });
  const tokenSpend = state.tokenBudget?.spend({ amount: estimatedTokens, now });
  return actualTokens => tokenSpend?.reconcile(actualTokens);
}
