import type { Provider, ProviderEvent, ProviderMessage, ProviderRequest, ProviderSettings, ProviderToolSpec } from '../providers/provider-types.js';
import type { LanePriority, Scheduler } from '../scheduler/scheduler-types.js';
import type { AigentEvent } from './aigent-events.js';
import { leasedStream } from './leased-stream.js';
import type { ResiliencePolicy } from './resilience-policy.js';
import type { RandomSource, Sleeper } from './runtime-services.js';
import { streamWithResilience } from './stream-with-resilience.js';
import type { ProviderAttempt } from './stream-with-resilience.js';

/** One model a turn may use, with the settings that provider can honour. */
export interface ProviderTarget {
  /** `provider:model`. */
  label: string;
  provider: Provider;
  /** Model id without the provider prefix. */
  model: string;
  /** Already filtered for this provider; absent when none are set. */
  settings?: ProviderSettings;
  /** One per setting this provider leaves out; emitted the first time the run uses the target. */
  warnings: string[];
  /** The resolved settings this provider leaves out, for the run record. */
  dropped: (keyof ProviderSettings)[];
}

/** Which models a run's turns use and how failures are retried; shared by every turn of the run. */
export interface TurnRouting {
  /** Primary first, then fallbacks. */
  targets: [ProviderTarget, ...ProviderTarget[]];
  policy: ResiliencePolicy;
  sleep: Sleeper;
  random: RandomSource;
  /** Labels this run has used (the primary from the start, fallbacks once reached); their setting warnings are emitted on first use. */
  usedLabels: Set<string>;
  /** Every provider call waits for a lease from it. */
  scheduler: Scheduler;
  priority: LanePriority;
  agentName: string;
}

/** Retry and fallback counts, updated as they happen. */
export interface ResilienceCounters {
  retries: number;
  fallbacks: number;
}

/** The parts of a provider request that are the same for every target. */
export interface TurnRequest {
  messages: ProviderMessage[];
  tools: ProviderToolSpec[];
  /** Indices into `messages` after which a prompt-cache breakpoint belongs (see `ProviderRequest.cacheBreakpoints`). */
  cacheBreakpoints?: number[];
  /** Given only to targets whose provider owns the loop (`capabilities.ownsLoop`). */
  toolExecutor?: ProviderRequest['toolExecutor'];
}

export interface OpenTurnStreamParams {
  routing: TurnRouting;
  request: TurnRequest;
  signal: AbortSignal;
  counters: ResilienceCounters;
  emit(event: AigentEvent): void;
  /**
   * Delegated mode: whether the provider's own loop already ran a tool call in this turn. Once it has, the turn is
   * never retried or moved to a fallback (that would run the call again), and the first-event timeout stops.
   */
  isCommitted?(): boolean;
}

interface TargetAttemptParams {
  target: ProviderTarget;
  request: TurnRequest;
  routing: TurnRouting;
  emit(event: AigentEvent): void;
  isCommitted?(): boolean;
}

/** Output tokens assumed for the scheduler's estimate when `maxOutputTokens` is not set. */
const DEFAULT_OUTPUT_TOKEN_ESTIMATE = 1024;
/** Rough characters per token for estimating input size from the request JSON. */
const CHARS_PER_TOKEN = 4;

/** Input estimated from the request size plus the most the model may write. */
function estimateTokens(params: { request: TurnRequest; settings?: ProviderSettings }): number {
  const { request: { messages, tools }, settings } = params;
  // Only what is sent as prompt text counts; cache breakpoints are markers, not tokens.
  return Math.ceil(JSON.stringify({ messages, tools }).length / CHARS_PER_TOKEN) + (settings?.maxOutputTokens ?? DEFAULT_OUTPUT_TOKEN_ESTIMATE);
}

function emitTargetWarnings(params: { target: ProviderTarget; routing: TurnRouting; emit(event: AigentEvent): void }): void {
  const { target: { label, warnings }, routing: { usedLabels }, emit } = params;
  if (usedLabels.has(label)) return;
  usedLabels.add(label);
  for (const message of warnings) emit({ type: 'warning', message });
}

/** One target as a resilient attempt: each open waits for a scheduler lease, then applies the first-event timeout. */
function targetAttempt(params: TargetAttemptParams): ProviderAttempt {
  const { target: { label, provider, model, settings }, request, routing: { scheduler, priority, agentName, policy, sleep }, emit, isCommitted } = params;
  const { messages, tools, cacheBreakpoints, toolExecutor } = request;
  const executor = provider.capabilities.ownsLoop === true && toolExecutor != null ? { toolExecutor } : {};
  const lease = { key: label, estimatedTokens: estimateTokens({ request, settings }), priority, agentName };
  return {
    label,
    open: signal => leasedStream({
      scheduler, lease, signal, sleep, firstEventTimeoutMs: policy.firstEventTimeoutMs, maxRateLimitPauseMs: policy.maxDelayMs,
      ...(isCommitted == null ? {} : { hasStarted: isCommitted }),
      open: streamSignal => provider.stream({ model, messages, tools, ...(settings == null ? {} : { settings }), ...(cacheBreakpoints == null ? {} : { cacheBreakpoints }), ...executor }, streamSignal),
      onQueued: ({ position, reason, waitMs }) => emit({ type: 'queued', position, reason, ...(waitMs == null ? {} : { waitMs }) }),
    }),
  };
}

/**
 * Streams one turn's model response through retry, first-event timeout and fallback, emitting `retry` and
 * `fallback` events (and a fallback target's setting warnings the first time it is used).
 */
export function openTurnStream(params: OpenTurnStreamParams): AsyncIterable<ProviderEvent> {
  const { routing, request, signal, counters, emit, isCommitted } = params;
  const { targets, policy, sleep, random } = routing;
  const [primary, ...fallbacks] = targets;
  const committed = isCommitted == null ? {} : { isCommitted };
  const attemptOf = (target: ProviderTarget): ProviderAttempt => targetAttempt({ target, request, routing, emit, ...committed });
  const attempts: [ProviderAttempt, ...ProviderAttempt[]] = [attemptOf(primary), ...fallbacks.map(attemptOf)];
  const targetsByLabel = new Map(targets.map(target => [target.label, target]));
  return streamWithResilience({
    attempts, sleep, random, signal, ...committed,
    // Each attempt applies the first-event timeout itself, after its lease, so queueing never counts as silence.
    policy: { ...policy, firstEventTimeoutMs: undefined },
    onRetry: ({ attempt, delayMs, label, reason }) => {
      counters.retries += 1;
      emit({ type: 'retry', attempt, delayMs, model: label, reason });
    },
    onFallback: ({ from, to, reason }) => {
      counters.fallbacks += 1;
      emit({ type: 'fallback', from, to, reason });
      const target = targetsByLabel.get(to);
      if (target != null) emitTargetWarnings({ target, routing, emit });
    },
  });
}
