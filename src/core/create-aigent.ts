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
import { createAgentResume } from '../resume/agent-resume.js';
import { createApprovalCenter } from '../approvals/approval-gate.js';
import { createAuditTrail } from '../approvals/audit-trail.js';
import { createAllowAlwaysRules } from '../approvals/allow-always.js';
import { costOfUsage } from '../scoring/pricing.js';
import type { StartedSubRun } from './delegation-types.js';
import type { TaskInput } from './task-input.js';
import { createInstanceRuntime } from '../resume/instance-runtime.js';
import { validateResumeOptions } from '../resume/resume-options.js';
import { createAigentError } from './aigent-error.js';
import { createChat } from '../chat/create-chat.js';
import { parseChatOptions } from '../chat/chat-options.js';
import type { VolatileOptions } from '../context/volatile-block.js';
import { parseActivityOptions } from './activity-options.js';
import { parseGuardrailOptions } from '../guardrails/guardrail-options.js';
import { createRuntimeEffectLog } from '../effects/runtime-effect-log.js';
import { parseUndoTarget, undoEffects } from '../effects/undo.js';
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
  validateResumeOptions({ ...(options.resume == null ? {} : { resume: options.resume }), captureContent, hasRedact: redact != null });
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
  const resume = options.resume == null ? undefined : createInstanceRuntime({ options: options.resume, store: store ?? createInMemoryStore(), writeQueue, ...(redact == null ? {} : { redact }), clock, sleep: createTimerSleeper({ unref: true }), ownerId: ids.next('owner') });
  const effectLog = createRuntimeEffectLog({ store, writeQueue, ...(redact == null ? {} : { redact }), clock, ids, options: options.undo });
  const telemetry = { ...(writer == null ? {} : { writer }), captureContent, ...(expiresInMs == null ? {} : { expiresInMs }) };
  const recordFeedback = (feedback: UserFeedback): Promise<void> => recordUserFeedback({ store, ...(writer == null ? {} : { writer }), now: () => clock.now(), captureContent, feedback });
  // result.feedback goes through the same tracked path as ai.feedback.
  const services: RuntimeServices = {
    clock, ids, writeQueue, telemetry, submitFeedback: userFeedback => feedback(userFeedback), sleep, random, scheduler, volatile, isPrefixMonitorEnabled, compressionCache,
    ...(pricing == null ? {} : { pricing }),
    ...(activity == null ? {} : { activity }),
    activityTimers: createTimerSleeper(),
    ...(toolCache == null ? {} : { cache: toolCache }),
    ...(resume == null ? {} : { resume }),
    guardrails: parseGuardrailOptions(options.guardrails),
    effects: effectLog,
    startSubRun: request => startSubRun(request),
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

  /** Open chats, closed first by `close()`. */
  const chatClosers = new Set<() => Promise<void>>();
  /** Stored chat sessions open in this runtime (one live chat per session). */
  const openSessions = new Set<string>();

  /** The distinct `dispose` functions of every agent's tools (tools of one pack share one), called by `close()`. */
  const toolDisposers = new Set<() => Promise<void>>();

  async function close(): Promise<void> {
    // Every chat is closed even when one fails (e.g. its writes did not reach the store); the first failure is reported last.
    const closed = await Promise.allSettled([...chatClosers].map(closeChat => closeChat()));
    // Loop because a run or feedback call may be started while we wait for the earlier ones.
    while (activeWork.size > 0) await Promise.all([...activeWork]);
    await services.writeQueue.flush();
    await resume?.close();
    // Only once nothing runs: tools release what they hold (compiler processes), each even when another fails.
    const disposed = await Promise.allSettled([...toolDisposers].map(dispose => dispose()));
    const failed = [...closed, ...disposed].find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failed != null) throw failed.reason;
  }

  const agentContext: AgentResolutionContext = {
    resolveTarget, clock, ids, compressionCache,
    ...(runtimeSettings == null ? {} : { runtimeSettings }), ...(options.enableFeedback == null ? {} : { enableFeedback: options.enableFeedback }), ...(toolCache == null ? {} : { toolCache }),
  };

  /** The latest definition given for each agent name, so `restoreAgent` can rebuild an instance. */
  const definitions = new Map<string, AgentDefinition>();
  /** The latest agent created for each name, which `delegate` sub-runs run on. */
  const agentsByName = new Map<string, { agent: Agent; model: string }>();

  /** A sub-run of the named agent (for the `delegate` tool), priced at that agent's own model. */
  function startSubRun(request: { agentName: string; input: TaskInput }): StartedSubRun | undefined {
    const { agentName, input } = request;
    const entry = agentsByName.get(agentName);
    if (entry == null) return undefined;
    // A delegated tool-call budget may only lower the agent's own limit, never raise it.
    const own = definitions.get(agentName)?.limits?.maxToolCalls;
    const granted = input.limits?.maxToolCalls;
    const limits = granted == null || own == null ? input.limits : { ...input.limits, maxToolCalls: Math.min(own, granted) };
    return { run: entry.agent.task({ ...input, ...(limits == null ? {} : { limits }) }), price: usage => costOfUsage({ model: entry.model, usage, ...(pricing == null ? {} : { pricing }) }) ?? undefined };
  }
  /** `allow_always` decisions: per agent instance unless a decision widened them. */
  const allowAlways = createAllowAlwaysRules();
  const audit = createAuditTrail({ ...(writer == null ? {} : { records: writer }), clock });

  function agent(definition: AgentDefinition): Agent {
    const base = resolveAgent({ definition, context: agentContext });
    const { name, instanceId, agentVersion } = base;
    const resolved = { ...base, approvals: createApprovalCenter({ rules: options.approvals ?? {}, allowAlways, audit, clock, agent: { name, instanceId } }) };
    definitions.set(name, definition);
    for (const { dispose } of definition.tools ?? []) if (dispose != null) toolDisposers.add(dispose);
    const restore = createAgentResume({ agent: resolved, services, isExplicitInstance: definition.instanceId != null });
    /** This agent object's runs, so `close()` waits for them before it lets the instance go. */
    const agentWork = new Set<Promise<void>>();
    const trackAgent = (run: TaskRun): TaskRun => {
      const settled = Promise.resolve(run).then(() => undefined, () => undefined);
      agentWork.add(settled);
      void settled.then(() => agentWork.delete(settled));
      return track(run);
    };
    const created: Agent = {
      name,
      instanceId,
      agentVersion,
      ready: restore.ready,
      approve: (requestId, decision) => resolved.approvals.approve(requestId, decision),
      undo: async target => undoEffects({ log: effectLog, registry: resolved.registry, agent: { name, instanceId }, target: parseUndoTarget(target), clock, writeQueue }),
      resume: resumeOptions => { const run = restore.resume(resumeOptions); return run == null ? undefined : trackAgent(run); },
      task: rawInput => trackAgent(startTaskRun({ agent: resolved, services, input: parseTaskInput(rawInput) })),
      close: async () => {
        while (agentWork.size > 0) await Promise.all([...agentWork]);
        await resume?.release(instanceId);
      },
      preview: async rawInput => previewPrompt({ agent: resolved, services, ...(rawInput == null ? {} : { input: parseTaskInput(rawInput) }) }),
      chat: rawOptions => createChat({
        runtime: { agent: resolved, services }, options: parseChatOptions({ options: rawOptions, hasStore: store != null }), track: trackSettled, openSessions,
        registerCloser: closeChat => { chatClosers.add(closeChat); return () => { chatClosers.delete(closeChat); }; },
        ...(store == null || writer == null ? {} : { persistence: { store, writer } }),
      }),
    };
    agentsByName.set(name, { agent: created, model: resolved.targets[0].reference });
    return created;
  }

  async function restoreAgent(instanceId: string): Promise<Agent> {
    if (resume == null) throw createAigentError({ code: 'invalid_input', message: 'restoreAgent needs createAigent({ resume })', details: { instanceId } });
    const record = await resume.read(instanceId);
    if (record == null) throw createAigentError({ code: 'invalid_input', message: `No stored agent instance '${instanceId}'`, details: { instanceId } });
    const definition = definitions.get(record.agentName);
    if (definition == null) throw createAigentError({ code: 'invalid_input', message: `Instance '${instanceId}' belongs to agent '${record.agentName}'; define it with ai.agent first so its tools are known`, details: { instanceId, agentName: record.agentName } });
    const restored = agent({ ...definition, instanceId });
    await restored.ready;
    return restored;
  }

  return {
    agent,
    restoreAgent,
    close,
    trace: runId => readTrace({ store, runId }),
    purge: async filter => purgeRecords({ store, filter }),
    feedback,
    evalCompression: async params => evalCompression({ ...params, createAgent: agent }),
    report: async filter => readReport({ store, filter, now: () => clock.now(), ...(pricing == null ? {} : { pricing }) }),
  };
}
