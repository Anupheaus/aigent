import type { Aigent, AigentOptions } from './aigent-types.js';
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
import type { UserFeedback } from '../feedback/feedback-records.js';
import { recordUserFeedback } from '../feedback/user-feedback.js';
import type { Agent, AgentDefinition, TaskRun } from './agent-types.js';
import { parseModelSettings } from './model-settings.js';
import type { ModelSettings } from './model-settings.js';
import { resolveToolCache } from './resolve-tool-cache.js';
import { createMathRandom, createSystemClock, createTimerSleeper, createUuidGenerator } from './runtime-services.js';
import type { Clock, IdGenerator, RandomSource, Sleeper } from './runtime-services.js';
import { startTaskRun } from './start-task-run.js';
import type { RuntimeServices } from './start-task-run.js';
import { createTargetResolver } from './model-targets.js';
import { resolveAgent } from './resolve-agent.js';
import type { AgentResolutionContext } from './resolve-agent.js';
import { parseTaskInput } from './task-input.js';
import { parseVolatileOptions } from '../context/volatile-block.js';
import { createCompressionCache } from '../compression/compression-cache.js';
import { evalCompression } from '../compression/eval-compression.js';
import type { CompressionEvalReport, EvalCompressionParams } from '../compression/eval-compression.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { previewPrompt } from './preview.js';
import { createChat } from '../chat/create-chat.js';
import { parseChatOptions } from '../chat/chat-options.js';
import type { VolatileOptions } from '../context/volatile-block.js';
import { parseActivityOptions } from './activity-options.js';
import type { ActivityOptions } from './activity.js';

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
  const resolveTarget = createTargetResolver({ providers, ...(options.providerModelSettings == null ? {} : { providerModelSettings: options.providerModelSettings }) });
  const { expiresInMs } = parseRetention(options.retention) ?? {};
  const pricing = parsePricing(options.pricing);
  const runtimeSettings = parseModelSettings({ owner: 'createAigent', settings: options.modelSettings });
  const scheduler = resolveScheduler({ scheduler: options.scheduler, clock, sleep });
  const writeQueue = createWriteQueue();
  const toolCache = resolveToolCache({ cache: options.cache, store, captureContent, isRedacted: redact != null, ...(expiresInMs == null ? {} : { expiresInMs }), writeQueue, clock });
  const volatile = parseVolatileOptions(options.volatile);
  const activity = parseActivityOptions(options.activity);
  // Compressed text is content: like the tool cache, it stays in memory when the store's owner asked for no content.
  const compressionStore = store != null && captureContent && redact == null ? store : createInMemoryStore();
  const compressionCache = createCompressionCache({ store: compressionStore, writeQueue });
  // process is absent outside Node (e.g. edge runtimes); without it no NODE_ENV is set.
  const isProduction = typeof process !== 'undefined' && process.env.NODE_ENV === 'production';
  const isPrefixMonitorEnabled = volatile.warnOnPrefixChange ?? !isProduction;
  const writer = store == null ? undefined : createRecordWriter({ store, writeQueue, redact });
  const telemetry = { ...(writer == null ? {} : { writer }), captureContent, ...(expiresInMs == null ? {} : { expiresInMs }) };
  const recordFeedback = (feedback: UserFeedback): Promise<void> => recordUserFeedback({ store, ...(writer == null ? {} : { writer }), now: () => clock.now(), captureContent, feedback });
  // result.feedback goes through the same tracked path as ai.feedback.
  const services: RuntimeServices = {
    clock, ids, writeQueue, telemetry, submitFeedback: userFeedback => feedback(userFeedback), sleep, random, scheduler, volatile, isPrefixMonitorEnabled, compressionCache,
    ...(pricing == null ? {} : { pricing }),
    ...(activity == null ? {} : { activity }),
    activityTimers: createTimerSleeper(),
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

  const agentContext: AgentResolutionContext = {
    resolveTarget, clock, ids, compressionCache,
    ...(runtimeSettings == null ? {} : { runtimeSettings }), ...(options.enableFeedback == null ? {} : { enableFeedback: options.enableFeedback }), ...(toolCache == null ? {} : { toolCache }),
  };

  function agent(definition: AgentDefinition): Agent {
    const resolved = resolveAgent({ definition, context: agentContext });
    const { name, instanceId, agentVersion } = resolved;
    return {
      name,
      instanceId,
      agentVersion,
      task: rawInput => track(startTaskRun({ agent: resolved, services, input: parseTaskInput(rawInput) })),
      preview: async rawInput => previewPrompt({ agent: resolved, services, ...(rawInput == null ? {} : { input: parseTaskInput(rawInput) }) }),
      chat: rawOptions => createChat({
        runtime: { agent: resolved, services }, options: parseChatOptions({ options: rawOptions, hasStore: store != null }), track: trackSettled,
        ...(store == null || writer == null ? {} : { persistence: { store, writer } }),
      }),
    };
  }

  return {
    agent,
    close,
    trace: runId => readTrace({ store, runId }),
    purge: async filter => purgeRecords({ store, filter }),
    feedback,
    evalCompression: async params => evalCompression({ ...params, createAgent: agent }),
    report: async filter => readReport({ store, filter, now: () => clock.now(), ...(pricing == null ? {} : { pricing }) }),
  };
}
