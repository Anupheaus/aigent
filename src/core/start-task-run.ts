import type { ToolCache } from '../cache/cache-types.js';
import type { FeedbackCollector } from '../feedback/feedback-collector.js';
import type { Provider } from '../providers/provider-types.js';
import type { Scheduler } from '../scheduler/scheduler-types.js';
import type { WriteQueue } from '../store/write-queue.js';
import { measureQueueWait } from '../telemetry/measure-queue.js';
import type { ShapersSetting } from '../shapers/shaper-types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { AigentEvent } from './aigent-events.js';
import { DEFAULT_LIMITS } from './agent-types.js';
import type { TaskResult, TaskResultData, TaskRun } from './agent-types.js';
import type { UserFeedback } from '../feedback/feedback-records.js';
import { createEventStream } from './event-stream.js';
import { filterProviderSettings } from './filter-provider-settings.js';
import type { ModelSettings } from './model-settings.js';
import type { ProviderTarget, TurnRouting } from './open-turn-stream.js';
import type { ResiliencePolicy } from './resilience-policy.js';
import { resolveModelSettings } from './resolve-model-settings.js';
import { createRunControl } from './run-control.js';
import { setUpRunShaping } from './run-shaping.js';
import { createStabilityMonitor } from '../context/stability-monitor.js';
import type { VolatileOptions } from '../context/volatile-block.js';
import { runTask } from './run-task.js';
import { createRunTelemetry, persistRunTelemetry } from './run-telemetry.js';
import type { TelemetrySettings } from './run-telemetry.js';
import type { Clock, IdGenerator, RandomSource, Sleeper } from './runtime-services.js';
import type { PromptPersona } from './system-prompt.js';
import type { TaskInput, TaskLimits } from './task-input.js';

/** A model an agent can call: provider resolved, plus that provider's settings layer. */
export interface ModelTarget {
  /** `provider:model`, as written in the definition. */
  reference: string;
  provider: Provider;
  /** Model id without the provider prefix. */
  model: string;
  /** `createAigent({ providerModelSettings })` for this provider. */
  providerSettings?: ModelSettings;
}

/** An agent definition after validation: provider resolved, registry built, version computed. */
export interface ResolvedAgent {
  name: string;
  instanceId: string;
  /** The agent's model first, then its fallback models. */
  targets: [ModelTarget, ...ModelTarget[]];
  resilience: ResiliencePolicy;
  prompt: PromptPersona;
  registry: ToolRegistry;
  limits?: TaskLimits;
  agentSettings?: ModelSettings;
  /** `createAigent({ modelSettings })`. */
  runtimeSettings?: ModelSettings;
  agentVersion: string;
  /** The definition's human version label. */
  version?: string;
  /** Present when feedback is enabled; holds each run's `aigent_feedback` entries until they are stored. */
  feedbackCollector?: FeedbackCollector;
  /** The definition's `shapers`, validated. */
  shapers?: ShapersSetting;
}

/** Shared, per-`createAigent` services. */
export interface RuntimeServices {
  clock: Clock;
  ids: IdGenerator;
  /** Flushed by `ai.close()`; every store write goes through it. */
  writeQueue: WriteQueue;
  telemetry: TelemetrySettings;
  /** `ai.feedback`, behind `TaskResult.feedback`. */
  submitFeedback(feedback: UserFeedback): Promise<void>;
  sleep: Sleeper;
  random: RandomSource;
  scheduler: Scheduler;
  /** The tool-result cache shared by every agent of the runtime; absent with `cache: false`. */
  cache?: ToolCache;
  /** `createAigent({ volatile })`, validated. */
  volatile: VolatileOptions;
  /** Whether runs warn when their prompt prefix changes between turns. */
  isPrefixMonitorEnabled: boolean;
}

export interface StartTaskRunParams {
  agent: ResolvedAgent;
  services: RuntimeServices;
  /** Already validated. */
  input: TaskInput;
}

interface ResolvedLimits {
  maxTurns: number;
  maxToolCalls: number;
  timeoutMs?: number;
}

/** Task limits win over agent limits, field by field, then the library defaults. */
function resolveLimits(taskLimits: TaskLimits | undefined, agentLimits: TaskLimits | undefined): ResolvedLimits {
  return {
    maxTurns: taskLimits?.maxTurns ?? agentLimits?.maxTurns ?? DEFAULT_LIMITS.maxTurns,
    maxToolCalls: taskLimits?.maxToolCalls ?? agentLimits?.maxToolCalls ?? DEFAULT_LIMITS.maxToolCalls,
    timeoutMs: taskLimits?.timeoutMs ?? agentLimits?.timeoutMs,
  };
}

interface ProviderTargetParams {
  target: ModelTarget;
  agent: ResolvedAgent;
  input: TaskInput;
}

/** Resolves the run's settings for one model (its provider's layer differs) and filters them for that provider. */
function toProviderTarget(params: ProviderTargetParams): ProviderTarget {
  const { target: { reference, provider, model, providerSettings }, agent: { agentSettings, runtimeSettings }, input } = params;
  const settings = resolveModelSettings({ task: input.modelSettings, agent: agentSettings, runtime: runtimeSettings, provider: providerSettings });
  const filtered = filterProviderSettings({ provider, model, settings });
  const { warnings, dropped } = filtered;
  return { label: reference, provider, model, warnings, dropped, ...(filtered.settings == null ? {} : { settings: filtered.settings }) };
}

/** Adds `feedback` as a non-enumerable method, so results stay plain data for `toEqual`, JSON and structured clones. */
function withFeedbackShortcut(params: { result: TaskResultData; submitFeedback: RuntimeServices['submitFeedback'] }): TaskResult {
  const { result, submitFeedback } = params;
  const { responseId } = result;
  const feedback: TaskResult['feedback'] = rating => submitFeedback({ ...rating, responseId });
  return Object.defineProperty(result, 'feedback', { value: feedback, enumerable: false }) as TaskResult;
}

/** Starts a task in the background and returns its awaitable, iterable, stoppable handle. */
export function startTaskRun(params: StartTaskRunParams): TaskRun {
  const { agent, services, input } = params;
  const { name: agentName, instanceId, targets, resilience, prompt, agentVersion, version } = agent;
  const { clock, ids, sleep, random, scheduler } = services;
  const [target, ...fallbackTargets] = targets;
  const runId = ids.next('run');
  const responseId = ids.next('resp');
  const { feedbackCollector } = agent;
  const telemetry = createRunTelemetry({ now: () => clock.now(), runId, settings: services.telemetry, enableFeedback: feedbackCollector != null });
  const shapersSetting = input.shapers ?? agent.shapers;
  const { registry, shaping } = setUpRunShaping({ registry: agent.registry, settings: shapersSetting, isFeedbackEnabled: feedbackCollector != null });
  const { maxTurns, maxToolCalls, timeoutMs } = resolveLimits(input.limits, agent.limits);
  const settings = resolveModelSettings({ task: input.modelSettings, agent: agent.agentSettings, runtime: agent.runtimeSettings, provider: target.providerSettings });
  const primary = toProviderTarget({ target, agent, input });
  const fallbacks = fallbackTargets.map(modelTarget => toProviderTarget({ target: modelTarget, agent, input }));
  const priority = input.priority ?? (input.unattended === true ? 'background' : 'interactive');
  const measuredScheduler = measureQueueWait({ scheduler, now: () => clock.now(), onWait: waitedMs => telemetry.timer.addQueuedMs(waitedMs) });
  const routing: TurnRouting = { targets: [primary, ...fallbacks], policy: resilience, sleep, random, usedLabels: new Set([primary.label]), scheduler: measuredScheduler, priority, agentName };
  const stream = createEventStream<AigentEvent, TaskResult>();
  const emit = (event: AigentEvent): void => stream.push(event);
  const { control, stop, dispose } = createRunControl({ signal: input.signal, timeoutMs });

  async function execute(): Promise<void> {
    for (const message of primary.warnings) emit({ type: 'warning', message });
    let resultData: TaskResultData;
    try {
      resultData = await runTask({
        runId, responseId, agentName, instanceId, prompt, input, registry, clock, control, telemetry, emit,
        ...(services.cache == null ? {} : { cache: services.cache }),
        ...(shaping == null ? {} : { shaping }),
        volatile: { options: services.volatile, monitor: createStabilityMonitor({ emit, isEnabled: services.isPrefixMonitorEnabled }), extras: () => [] },
        routing,
        showThinking: settings.showThinking ?? true,
        limits: { maxTurns, maxToolCalls },
      });
    } finally {
      dispose();
    }
    // Taken even when nothing is stored, so a disabled run's entries are not kept in memory.
    const feedback = feedbackCollector?.take(runId) ?? [];
    // disableTelemetry runs (evals, tests) write nothing at all, so they never reach scores.
    if (input.disableTelemetry !== true) {
      const usedFallbacks = fallbacks.filter(({ label }) => routing.usedLabels.has(label));
      const warning = await persistRunTelemetry({
        now: () => clock.now(), telemetry, settings: services.telemetry, feedback,
        run: { input, result: resultData, agent: { agentVersion, version }, targets: { primary, fallbacks: usedFallbacks, runtimeSettings: settings } },
      });
      if (warning != null) emit({ type: 'warning', message: warning });
    }
    // `done` is last and only after the records are flushed, so a consumer that sees it can read them.
    emit({ type: 'done', status: resultData.status, responseId });
    stream.finish(withFeedbackShortcut({ result: resultData, submitFeedback: services.submitFeedback }));
  }

  // Deferred so the caller can attach iterators first (events are buffered regardless).
  queueMicrotask(() => { execute().catch(error => stream.fail(error)); });

  const run: TaskRun = Object.assign(stream.run, { runId, stop, cancel: () => stop({ mode: 'immediate' }) });
  return run;
}
