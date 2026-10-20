import type { Clock, Sleeper } from '../core/runtime-services.js';

/** Interactive requests (someone is waiting) go before background ones (unattended work). */
export type LanePriority = 'interactive' | 'background';

/** What a queued request is waiting for. A rate-limit pause after a 429 is reported as `requests-per-minute`. */
export type QueueReason = 'concurrency' | 'requests-per-minute' | 'tokens-per-minute';

/** Limits for one provider (or one `provider:model`); an absent field is unlimited. */
export interface ProviderLimits {
  maxConcurrent?: number;
  /** Requests admitted in any 60 s window. */
  requestsPerMinute?: number;
  /** Tokens (estimated at admission, corrected on release) in any 60 s window. */
  tokensPerMinute?: number;
}

export interface SchedulerOptions {
  /** Keyed by provider id, or `provider:model` for model-specific limits; the most specific key wins. */
  limits?: Record<string, ProviderLimits>;
  /** Limits for providers with no entry in `limits`, applied per provider id. */
  defaultLimits?: ProviderLimits;
  /** Default: the system clock. */
  clock?: Clock;
  /** Waits for budgets to refill and pauses to end. Default: real timers. */
  sleep?: Sleeper;
  /** A background request waiting longer than this joins the interactive lane, so it is never starved (default 60_000). */
  maxBackgroundWaitMs?: number;
}

export interface QueuedInfo {
  /**
   * 1-based place in admission order (lane first, then fairness across agents) when the request joined the queue;
   * not its arrival order. Later arrivals can move it.
   */
  position: number;
  reason: QueueReason;
  /** Known wait for a time-based reason (budget refill or pause), in ms. */
  waitMs?: number;
}

export interface LeaseRequest {
  /** `provider:model`. */
  key: string;
  /** Tokens counted against `tokensPerMinute` at admission; corrected by `release({ tokens })`. */
  estimatedTokens: number;
  priority: LanePriority;
  /** Requests are shared fairly across agents within a lane. */
  agentName: string;
  /** Aborting removes a queued request at once and rejects it with an `aborted` AigentError, consuming nothing. */
  signal: AbortSignal;
  /** Called once, only when the request could not be admitted at once. If it throws, the request is withdrawn and `acquire` rejects with that error. */
  onQueued?(info: QueuedInfo): void;
}

export interface LeaseUsage {
  /** Tokens the call actually used, replacing the estimate in the budget. */
  tokens: number;
}

export interface Lease {
  /** Frees the concurrency slot; idempotent. */
  release(actual?: LeaseUsage): void;
}

export interface RateLimitReport {
  key: string;
  retryAfterMs: number;
}

export interface UsageReport {
  key: string;
  tokens: number;
}

export interface KeySnapshot {
  inFlight: number;
  queued: number;
  interactiveQueued: number;
  backgroundQueued: number;
}

/** Keyed by the limit key requests resolved to (provider id, or `provider:model` when that has its own limits). */
export type SchedulerSnapshot = Record<string, KeySnapshot>;

/**
 * Decides when each provider call may start, so agents sharing providers respect concurrency and per-minute limits.
 * An interface so a cross-process implementation can replace the in-memory one.
 */
export interface Scheduler {
  acquire(request: LeaseRequest): Promise<Lease>;
  /** Pauses the key for `retryAfterMs` and halves its concurrency for the next 10 admissions. */
  reportRateLimit(report: RateLimitReport): void;
  /** Counts tokens used outside a lease against the key's token budget. */
  reportUsage(report: UsageReport): void;
  snapshot(): SchedulerSnapshot;
}
