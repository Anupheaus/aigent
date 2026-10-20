import type { Provider, ProviderEvent, ProviderMessage, ProviderSettings, ProviderToolSpec } from '../providers/provider-types.js';
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
}

/** Which models a run's turns use and how failures are retried; shared by every turn of the run. */
export interface TurnRouting {
  /** Primary first, then fallbacks. */
  targets: [ProviderTarget, ...ProviderTarget[]];
  policy: ResiliencePolicy;
  sleep: Sleeper;
  random: RandomSource;
  /** Labels whose setting warnings were already emitted in this run. */
  warnedLabels: Set<string>;
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
}

export interface OpenTurnStreamParams {
  routing: TurnRouting;
  request: TurnRequest;
  signal: AbortSignal;
  counters: ResilienceCounters;
  emit(event: AigentEvent): void;
}

interface TargetAttemptParams {
  target: ProviderTarget;
  request: TurnRequest;
  routing: TurnRouting;
  emit(event: AigentEvent): void;
}

/** Output tokens assumed for the scheduler's estimate when `maxOutputTokens` is not set. */
const DEFAULT_OUTPUT_TOKEN_ESTIMATE = 1024;
/** Rough characters per token for estimating input size from the request JSON. */
const CHARS_PER_TOKEN = 4;

/** Input estimated from the request size plus the most the model may write. */
function estimateTokens(params: { request: TurnRequest; settings?: ProviderSettings }): number {
  const { request, settings } = params;
  return Math.ceil(JSON.stringify(request).length / CHARS_PER_TOKEN) + (settings?.maxOutputTokens ?? DEFAULT_OUTPUT_TOKEN_ESTIMATE);
}

function emitTargetWarnings(params: { target: ProviderTarget; routing: TurnRouting; emit(event: AigentEvent): void }): void {
  const { target: { label, warnings }, routing: { warnedLabels }, emit } = params;
  if (warnedLabels.has(label)) return;
  warnedLabels.add(label);
  for (const message of warnings) emit({ type: 'warning', message });
}

/** One target as a resilient attempt: each open waits for a scheduler lease, then applies the first-event timeout. */
function targetAttempt(params: TargetAttemptParams): ProviderAttempt {
  const { target: { label, provider, model, settings }, request, routing: { scheduler, priority, agentName, policy, sleep }, emit } = params;
  const { messages, tools } = request;
  const lease = { key: label, estimatedTokens: estimateTokens({ request, settings }), priority, agentName };
  return {
    label,
    open: signal => leasedStream({
      scheduler, lease, signal, sleep, firstEventTimeoutMs: policy.firstEventTimeoutMs,
      open: streamSignal => provider.stream({ model, messages, tools, ...(settings == null ? {} : { settings }) }, streamSignal),
      onQueued: ({ position, reason, waitMs }) => emit({ type: 'queued', position, reason, ...(waitMs == null ? {} : { waitMs }) }),
    }),
  };
}

/**
 * Streams one turn's model response through retry, first-event timeout and fallback, emitting `retry` and
 * `fallback` events (and a fallback target's setting warnings the first time it is used).
 */
export function openTurnStream(params: OpenTurnStreamParams): AsyncIterable<ProviderEvent> {
  const { routing, request, signal, counters, emit } = params;
  const { targets, policy, sleep, random } = routing;
  const [primary, ...fallbacks] = targets;
  const attempts: [ProviderAttempt, ...ProviderAttempt[]] = [targetAttempt({ target: primary, request, routing, emit }), ...fallbacks.map(target => targetAttempt({ target, request, routing, emit }))];
  const targetsByLabel = new Map(targets.map(target => [target.label, target]));
  return streamWithResilience({
    attempts, sleep, random, signal,
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
