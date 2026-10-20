import type { CacheOptions } from '../cache/cache-types.js';
import type { Provider } from '../providers/provider-types.js';
import { createScheduler } from '../scheduler/scheduler.js';
import type { Scheduler, SchedulerOptions } from '../scheduler/scheduler-types.js';
import type { PurgeFilter, Store } from '../store/store-types.js';
import { createWriteQueue } from '../store/write-queue.js';
import { purgeRecords } from '../telemetry/purge-records.js';
import { readTrace } from '../telemetry/read-trace.js';
import { createRecordWriter } from '../telemetry/record-writer.js';
import type { Redact } from '../telemetry/redact.js';
import { parseRetention } from '../telemetry/retention.js';
import { parsePricing } from '../scoring/pricing.js';
import { readReport } from '../scoring/read-report.js';
import type { Pricing, Report, ReportFilter } from '../scoring/report-types.js';
import type { RetentionOptions } from '../telemetry/retention.js';
import type { RunTrace } from '../telemetry/run-record.js';
import { createFeedbackCollector } from '../feedback/feedback-collector.js';
import { resolveEnableFeedback } from '../feedback/resolve-enable-feedback.js';
import type { UserFeedback } from '../feedback/feedback-records.js';
import { recordUserFeedback } from '../feedback/user-feedback.js';
import { createAigentError } from './aigent-error.js';
import type { Agent, AgentDefinition, TaskRun } from './agent-types.js';
import { computeAgentVersion } from './agent-version.js';
import { buildAgentRegistry } from './build-agent-registry.js';
import { LIBRARY_VERSION } from './library-version.js';
import { parseModelReference } from './model-reference.js';
import { parseModelSettings } from './model-settings.js';
import type { ModelSettings } from './model-settings.js';
import { parseResiliencePolicy } from './resilience-policy.js';
import { resolveToolCache } from './resolve-tool-cache.js';
import { resolveModelSettings } from './resolve-model-settings.js';
import { createMathRandom, createSystemClock, createTimerSleeper, createUuidGenerator } from './runtime-services.js';
import type { Clock, IdGenerator, RandomSource, Sleeper } from './runtime-services.js';
import { startTaskRun } from './start-task-run.js';
import type { ModelTarget, ResolvedAgent, RuntimeServices } from './start-task-run.js';
import { parseAgentLimits, parseTaskInput } from './task-input.js';
import { parseAgentShapers } from '../shapers/shapers-setting.js';
import { parseVolatileOptions } from '../context/volatile-block.js';
import type { VolatileOptions } from '../context/volatile-block.js';

export interface AigentOptions {
  /** Every provider agents may use; ids must be unique. */
  providers: Provider[];
  /** Where run records are written; nothing is persisted without one. */
  store?: Store;
  clock?: Clock;
  ids?: IdGenerator;
  /** Waits between retries (default: real timers). Inject a fake to control time in tests. */
  sleep?: Sleeper;
  /** Jitter source (default `Math.random`). */
  random?: RandomSource;
  /**
   * Admits every provider call (concurrency, per-minute budgets, priority lanes, fairness). Pass one `Scheduler` to
   * several `createAigent` instances to share limits, or options to build one. Default: no limits.
   */
  scheduler?: Scheduler | SchedulerOptions;
  /** Runtime-wide model settings; agent and task settings win over them, field by field. */
  modelSettings?: ModelSettings;
  /** Per-provider default settings, keyed by provider id; the lowest-precedence layer. */
  providerModelSettings?: Record<string, ModelSettings>;
  /**
   * Applied to every record of every collection before it reaches the store (it gets a copy and may change `value`).
   * If it throws, that record is not written and the run emits a warning.
   */
  redact?: Redact;
  /**
   * Store task text, answers, tool argument values and feedback text (default true). False keeps metrics, argument
   * shapes and digests, and only the kinds and lengths of user and agent feedback text.
   */
  captureContent?: boolean;
  /** Retention hints stamped on records as `expiresAt`; the store decides whether to honour them. */
  retention?: RetentionOptions;
  /** Default for agents that do not set `enableFeedback`; when absent, on unless `NODE_ENV` is `production`. */
  enableFeedback?: boolean;
  /** Model prices keyed `provider:model`, so `ai.report()` can score cost; cost is null without them. */
  pricing?: Pricing;
  /**
   * The tool-result cache for tools declared `cache: true` (on by default): limits, or false to turn it off. Entries go
   * to the runtime `store` (collection `toolcache`); without a store, or with `captureContent: false`, to a private
   * in-memory store, so tool results never reach a store whose owner asked for no content.
   */
  cache?: CacheOptions | false;
  /**
   * The trailing `# Current state` block added to every request (date and time, locale, progress, plan and todo
   * statuses), so the messages before it stay byte-stable for provider prompt caching.
   */
  volatile?: VolatileOptions;
}

export interface Aigent {
  /** Validates the definition (throws `invalid_definition` / `unknown_provider`) and returns the agent. */
  agent(definition: AgentDefinition): Agent;
  /**
   * Resolves once every run and `ai.feedback` call started so far (and any started while closing) has settled and every pending store
   * write has been flushed, so run records are not lost on shutdown. It does not stop runs; stop them first to close quickly.
   */
  close(): Promise<void>;
  /** A stored run with its ordered steps, or undefined when it was not stored (no store, unknown id, disableTelemetry). */
  trace(runId: string): Promise<RunTrace | undefined>;
  /**
   * Deletes matching records from every collection through `Store.purge`; resolves with how many went. Rejects with
   * `invalid_input` for an empty filter, without a store, or when the store does not implement `purge`.
   */
  purge(filter: PurgeFilter): Promise<number>;
  /**
   * Records a user's rating of a response (validated; a later call amends it and keeps the history) and marks the run
   * record's `userVerdict`. Works after the run, and from any runtime on the same store. Rejects with `invalid_input`
   * for an invalid payload, an unknown `responseId` (including disableTelemetry runs) or no store.
   */
  feedback(feedback: UserFeedback): Promise<void>;
  /**
   * Scores (against each agent version's own rolling baseline), findings and an optional version comparison over the
   * stored runs that match `filter`. Rejects with `invalid_input` for an invalid filter; empty without a store.
   */
  report(filter?: ReportFilter): Promise<Report>;
}

function indexProviders(providers: Provider[]): Map<string, Provider> {
  const byId = new Map<string, Provider>();
  for (const provider of providers) {
    if (byId.has(provider.id)) {
      throw createAigentError({ code: 'invalid_definition', message: `Duplicate provider id '${provider.id}'; each provider must have a unique id`, details: { providerId: provider.id } });
    }
    byId.set(provider.id, provider);
  }
  return byId;
}

function unknownProviderError(params: { providerId: string; providersById: Map<string, Provider> }): Error {
  const { providerId, providersById } = params;
  const knownIds = [...providersById.keys()].join(', ') || '(none)';
  return createAigentError({ code: 'unknown_provider', message: `Unknown provider '${providerId}'; known providers: ${knownIds}`, details: { providerId } });
}

/** Validates every per-provider settings layer up front, so a typo fails at `createAigent`, not on a later task. */
function parseProviderModelSettings(params: { settings: Record<string, ModelSettings> | undefined; providersById: Map<string, Provider> }): Map<string, ModelSettings> {
  const { settings = {}, providersById } = params;
  return new Map(Object.entries(settings).map(([providerId, providerSettings]) => {
    if (!providersById.has(providerId)) throw unknownProviderError({ providerId, providersById });
    return [providerId, parseModelSettings({ owner: `Provider '${providerId}'`, settings: providerSettings }) ?? {}];
  }));
}

function isScheduler(value: Scheduler | SchedulerOptions): value is Scheduler {
  return typeof (value as Partial<Scheduler>).acquire === 'function';
}

/** The given scheduler, or one built from options (defaulting to this aigent's clock and sleep). */
function resolveScheduler(params: { scheduler: Scheduler | SchedulerOptions | undefined; clock: Clock; sleep: Sleeper }): Scheduler {
  const { scheduler = {}, clock, sleep } = params;
  return isScheduler(scheduler) ? scheduler : createScheduler({ clock, sleep, ...scheduler });
}

export function createAigent(options: AigentOptions): Aigent {
  const { providers, store, clock = createSystemClock(), ids = createUuidGenerator(), sleep = createTimerSleeper(), random = createMathRandom(), redact, captureContent = true } = options;
  const providersById = indexProviders(providers);
  const { expiresInMs } = parseRetention(options.retention) ?? {};
  const pricing = parsePricing(options.pricing);
  const runtimeSettings = parseModelSettings({ owner: 'createAigent', settings: options.modelSettings });
  const providerSettingsById = parseProviderModelSettings({ settings: options.providerModelSettings, providersById });
  const scheduler = resolveScheduler({ scheduler: options.scheduler, clock, sleep });
  const writeQueue = createWriteQueue();
  const toolCache = resolveToolCache({ cache: options.cache, store, captureContent, isRedacted: redact != null, ...(expiresInMs == null ? {} : { expiresInMs }), writeQueue, clock });
  const volatile = parseVolatileOptions(options.volatile);
  // process is absent outside Node (e.g. edge runtimes); without it no NODE_ENV is set.
  const isProduction = typeof process !== 'undefined' && process.env.NODE_ENV === 'production';
  const isPrefixMonitorEnabled = volatile.warnOnPrefixChange ?? !isProduction;
  const writer = store == null ? undefined : createRecordWriter({ store, writeQueue, redact });
  const telemetry = { ...(writer == null ? {} : { writer }), captureContent, ...(expiresInMs == null ? {} : { expiresInMs }) };
  const recordFeedback = (feedback: UserFeedback): Promise<void> => recordUserFeedback({ store, ...(writer == null ? {} : { writer }), now: () => clock.now(), captureContent, feedback });
  // result.feedback goes through the same tracked path as ai.feedback.
  const services: RuntimeServices = {
    clock, ids, writeQueue, telemetry, submitFeedback: userFeedback => feedback(userFeedback), sleep, random, scheduler, volatile, isPrefixMonitorEnabled,
    ...(toolCache == null ? {} : { cache: toolCache }),
  };
  /** Settles (never rejects) when its run or feedback call has finished, including its store writes. */
  const activeWork = new Set<Promise<void>>();

  function trackSettled(work: PromiseLike<unknown>): void {
    const settled = Promise.resolve(work).then(() => undefined, () => undefined);
    activeWork.add(settled);
    void settled.then(() => activeWork.delete(settled));
  }

  function track(run: TaskRun): TaskRun {
    trackSettled(run);
    return run;
  }

  /** Tracked like runs: a rating between its reads and its queued writes would otherwise be lost at close(). */
  function feedback(userFeedback: UserFeedback): Promise<void> {
    const recorded = recordFeedback(userFeedback);
    trackSettled(recorded);
    return recorded;
  }

  async function close(): Promise<void> {
    // Loop because a run or feedback call may be started while we wait for the earlier ones.
    while (activeWork.size > 0) await Promise.all([...activeWork]);
    await services.writeQueue.flush();
  }

  function resolveTarget(reference: string): ModelTarget {
    const { providerId, model } = parseModelReference(reference);
    const provider = providersById.get(providerId);
    if (provider == null) throw unknownProviderError({ providerId, providersById });
    const providerSettings = providerSettingsById.get(providerId);
    return { reference, provider, model, ...(providerSettings == null ? {} : { providerSettings }) };
  }

  function agent(definition: AgentDefinition): Agent {
    const { name, persona, skillset, context, tools = [], version, fallbackModels, resilience } = definition;
    // process is absent outside Node (e.g. edge runtimes); without it no NODE_ENV is set.
    const env = typeof process === 'undefined' ? {} : process.env;
    const enableFeedback = resolveEnableFeedback({ explicit: definition.enableFeedback ?? options.enableFeedback, env });
    if (name === '') throw createAigentError({ code: 'invalid_definition', message: 'Agent name must be a non-empty string' });
    const limits = parseAgentLimits({ agentName: name, limits: definition.limits });
    const agentSettings = parseModelSettings({ owner: `Agent '${name}'`, settings: definition.modelSettings });
    const policy = parseResiliencePolicy({ agentName: name, resilience });
    const shapers = parseAgentShapers({ agentName: name, shapers: definition.shapers });
    const target = resolveTarget(definition.model);
    const fallbackTargets = (fallbackModels ?? []).map(resolveTarget);
    const instanceId = definition.instanceId ?? ids.next('agent');
    const feedbackCollector = enableFeedback ? createFeedbackCollector() : undefined;
    const registry = buildAgentRegistry({
      agentName: name, tools, now: () => clock.now(),
      ...(feedbackCollector == null ? {} : { feedbackCollector }),
      ...(toolCache == null ? {} : { cache: toolCache }),
    });
    const effectiveSettings = resolveModelSettings({ agent: agentSettings, runtime: runtimeSettings, provider: target.providerSettings });
    // A fallback's provider layer can differ from the primary's, so each fallback's own effective settings are hashed.
    const fallbacks = fallbackTargets.map(({ reference, providerSettings }) => ({
      model: reference,
      modelSettings: resolveModelSettings({ agent: agentSettings, runtime: runtimeSettings, provider: providerSettings }),
    }));
    const agentVersion = computeAgentVersion({ libraryVersion: LIBRARY_VERSION, model: target.reference, persona, skillset, context, modelSettings: effectiveSettings, limits, version, tools, fallbacks, resilience: policy, enableFeedback, ...(shapers == null ? {} : { shapers }), ...(definition.todo === false ? { todo: false } : {}) });
    const resolved: ResolvedAgent = { name, instanceId, targets: [target, ...fallbackTargets], resilience: policy, prompt: { persona, skillset, context, enableFeedback }, registry, limits, agentSettings, runtimeSettings, agentVersion, version,
      ...(feedbackCollector == null ? {} : { feedbackCollector }),
      ...(shapers == null ? {} : { shapers }),
      isTodoEnabled: definition.todo !== false,
    };
    return {
      name,
      instanceId,
      agentVersion,
      task: rawInput => track(startTaskRun({ agent: resolved, services, input: parseTaskInput(rawInput) })),
    };
  }

  return {
    agent,
    close,
    trace: runId => readTrace({ store, runId }),
    purge: async filter => purgeRecords({ store, filter }),
    feedback,
    report: async filter => readReport({ store, filter, now: () => clock.now(), ...(pricing == null ? {} : { pricing }) }),
  };
}
