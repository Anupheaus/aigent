import type { Provider, ProviderEvent, ProviderMessage, ProviderSettings, ProviderToolSpec } from '../providers/provider-types.js';
import type { AigentEvent } from './aigent-events.js';
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
}

function emitTargetWarnings(params: { target: ProviderTarget; routing: TurnRouting; emit(event: AigentEvent): void }): void {
  const { target: { label, warnings }, routing: { warnedLabels }, emit } = params;
  if (warnedLabels.has(label)) return;
  warnedLabels.add(label);
  for (const message of warnings) emit({ type: 'warning', message });
}

function targetAttempt(params: TargetAttemptParams): ProviderAttempt {
  const { target: { label, provider, model, settings }, request: { messages, tools } } = params;
  return {
    label,
    open: signal => provider.stream({ model, messages, tools, ...(settings == null ? {} : { settings }) }, signal),
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
  const attempts: [ProviderAttempt, ...ProviderAttempt[]] = [targetAttempt({ target: primary, request }), ...fallbacks.map(target => targetAttempt({ target, request }))];
  const targetsByLabel = new Map(targets.map(target => [target.label, target]));
  return streamWithResilience({
    attempts, policy, sleep, random, signal,
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
