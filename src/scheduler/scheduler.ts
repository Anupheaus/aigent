import { createAigentError } from '../core/aigent-error.js';
import { createSystemClock, createTimerSleeper } from '../core/runtime-services.js';
import { blockFor, chargeAdmission, createKeyState } from './key-state.js';
import type { AdmissionBlock, KeyState, Waiter } from './key-state.js';
import { pickNextWaiter } from './pick-next-waiter.js';
import type { Lease, LeaseRequest, ProviderLimits, QueuedInfo, Scheduler, SchedulerOptions, SchedulerSnapshot } from './scheduler-types.js';

const DEFAULT_MAX_BACKGROUND_WAIT_MS = 60_000;
/** After a 429, this many admissions run at half concurrency. */
const RATE_LIMIT_HALVED_ADMISSIONS = 10;
/** Shortest wake-up delay, so a budget that reports no wait can never spin. */
const MIN_WAKE_MS = 1;
const PROVIDER_SEPARATOR = ':';
/** Reported when a request is only waiting behind others, with nothing time-based known. */
const FALLBACK_BLOCK: AdmissionBlock = { reason: 'concurrency' };

interface ResolvedLimits {
  limitKey: string;
  limits: ProviderLimits;
}

/**
 * The in-memory scheduler: per limit key, admits a request when concurrency, the per-minute budgets and any 429
 * pause allow; queued requests are ordered by lane, then fairly across agents (see `pickNextWaiter`).
 */
export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  const { limits = {}, defaultLimits = {}, clock = createSystemClock(), sleep = createTimerSleeper(), maxBackgroundWaitMs = DEFAULT_MAX_BACKGROUND_WAIT_MS } = options;
  const states = new Map<string, KeyState>();
  let arrivals = 0;
  let admissions = 0;

  /** `provider:model` limits win, then the provider's, then `defaultLimits` (shared per provider). */
  function resolveLimits(key: string): ResolvedLimits {
    const modelLimits = limits[key];
    if (modelLimits != null) return { limitKey: key, limits: modelLimits };
    const separatorIndex = key.indexOf(PROVIDER_SEPARATOR);
    const providerId = separatorIndex === -1 ? key : key.slice(0, separatorIndex);
    return { limitKey: providerId, limits: limits[providerId] ?? defaultLimits };
  }

  function stateFor(key: string): KeyState {
    const { limitKey, limits: keyLimits } = resolveLimits(key);
    const existing = states.get(limitKey);
    if (existing != null) return existing;
    const created = createKeyState(keyLimits);
    states.set(limitKey, created);
    return created;
  }

  function disarm(state: KeyState): void {
    state.wakeTimer?.abort();
    state.wakeTimer = undefined;
  }

  function arm(params: { state: KeyState; waitMs: number }): void {
    const { state, waitMs } = params;
    const timer = new AbortController();
    state.wakeTimer = timer;
    void sleep(Math.max(MIN_WAKE_MS, waitMs), timer.signal).then(() => {
      if (timer.signal.aborted) return;
      state.wakeTimer = undefined;
      pump(state);
    });
  }

  function removeWaiter(params: { state: KeyState; waiter: Waiter }): void {
    const { state, waiter } = params;
    const index = state.waiters.indexOf(waiter);
    if (index !== -1) state.waiters.splice(index, 1);
  }

  function admit(params: { state: KeyState; waiter: Waiter; now: number }): void {
    const { state, waiter, now } = params;
    const { request: { estimatedTokens, agentName } } = waiter;
    removeWaiter({ state, waiter });
    waiter.detach();
    const reconcileTokens = chargeAdmission({ state, estimatedTokens, now });
    admissions += 1;
    state.lastServed.set(agentName, admissions);
    let isReleased = false;
    const lease: Lease = {
      release: actual => {
        if (isReleased) return;
        isReleased = true;
        state.inFlight -= 1;
        if (actual != null) reconcileTokens(actual.tokens);
        pump(state);
      },
    };
    waiter.resolve(lease);
  }

  /** Admits as many waiters as the limits allow, in queue order, then arms a wake-up for a time-based block. */
  function pump(state: KeyState): void {
    disarm(state);
    for (;;) {
      const now = clock.now();
      const next = pickNextWaiter({ waiters: state.waiters, now, maxBackgroundWaitMs, lastServed: state.lastServed });
      if (next == null) return;
      const block = blockFor({ state, estimatedTokens: next.request.estimatedTokens, now });
      if (block == null) { admit({ state, waiter: next, now }); continue; }
      if (block.waitMs != null) arm({ state, waitMs: block.waitMs });
      return;
    }
  }

  /** Why `waiter` waits: its own block, else the block of the request ahead of it. */
  function queuedInfo(params: { state: KeyState; waiter: Waiter }): QueuedInfo {
    const { state, waiter } = params;
    const now = clock.now();
    const head = pickNextWaiter({ waiters: state.waiters, now, maxBackgroundWaitMs, lastServed: state.lastServed });
    const block = blockFor({ state, estimatedTokens: waiter.request.estimatedTokens, now })
      ?? (head == null ? undefined : blockFor({ state, estimatedTokens: head.request.estimatedTokens, now }))
      ?? FALLBACK_BLOCK;
    const { reason, waitMs } = block;
    return { position: state.waiters.indexOf(waiter) + 1, reason, ...(waitMs == null ? {} : { waitMs }) };
  }

  function acquire(request: LeaseRequest): Promise<Lease> {
    const { key, signal, onQueued, agentName, priority } = request;
    const abortedError = (): Error => createAigentError({ code: 'aborted', message: `Request for '${key}' by agent '${agentName}' was aborted while waiting for the scheduler` });
    const state = stateFor(key);
    if (signal.aborted) return Promise.reject(abortedError());
    return new Promise<Lease>((resolve, reject) => {
      const onAbort = (): void => {
        removeWaiter({ state, waiter });
        reject(abortedError());
        pump(state);
      };
      arrivals += 1;
      const waiter: Waiter = { request, agentName, priority, enqueuedAt: clock.now(), sequence: arrivals, resolve, detach: () => signal.removeEventListener('abort', onAbort) };
      signal.addEventListener('abort', onAbort, { once: true });
      state.waiters.push(waiter);
      pump(state);
      if (state.waiters.includes(waiter)) onQueued?.(queuedInfo({ state, waiter }));
    });
  }

  function snapshot(): SchedulerSnapshot {
    return Object.fromEntries([...states.entries()].map(([limitKey, { inFlight, waiters }]) => {
      const interactiveQueued = waiters.filter(({ priority }) => priority === 'interactive').length;
      return [limitKey, { inFlight, queued: waiters.length, interactiveQueued, backgroundQueued: waiters.length - interactiveQueued }];
    }));
  }

  return {
    acquire,
    reportRateLimit: ({ key, retryAfterMs }) => {
      const state = stateFor(key);
      state.pausedUntil = Math.max(state.pausedUntil, clock.now() + retryAfterMs);
      state.halvedAdmissionsLeft = RATE_LIMIT_HALVED_ADMISSIONS;
      pump(state);
    },
    reportUsage: ({ key, tokens }) => { stateFor(key).tokenBudget?.spend({ amount: tokens, now: clock.now() }); },
    snapshot,
  };
}
