import type { Provider } from '../providers/provider-types.js';
import type { Store } from '../store/store-types.js';
import type { WriteQueue } from '../store/write-queue.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { AigentEvent } from './aigent-events.js';
import { DEFAULT_LIMITS } from './agent-types.js';
import type { TaskResult, TaskRun } from './agent-types.js';
import { createEventStream } from './event-stream.js';
import { filterProviderSettings } from './filter-provider-settings.js';
import type { ModelSettings } from './model-settings.js';
import { resolveModelSettings } from './resolve-model-settings.js';
import { createRunControl } from './run-control.js';
import { buildRunRecord, writeRunRecord } from './run-record.js';
import { runTask } from './run-task.js';
import type { Clock, IdGenerator } from './runtime-services.js';
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
  target: ModelTarget;
  prompt: PromptPersona;
  registry: ToolRegistry;
  limits?: TaskLimits;
  agentSettings?: ModelSettings;
  /** `createAigent({ modelSettings })`. */
  runtimeSettings?: ModelSettings;
  agentVersion: string;
  /** The definition's human version label. */
  version?: string;
}

/** Shared, per-`createAigent` services. */
export interface RuntimeServices {
  clock: Clock;
  ids: IdGenerator;
  store?: Store;
  writeQueue: WriteQueue;
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

/** Starts a task in the background and returns its awaitable, iterable, stoppable handle. */
export function startTaskRun(params: StartTaskRunParams): TaskRun {
  const { agent, services, input } = params;
  const { name: agentName, instanceId, target, prompt, registry, agentVersion, version } = agent;
  const { clock, ids, store, writeQueue } = services;
  const runId = ids.next('run');
  const { maxTurns, maxToolCalls, timeoutMs } = resolveLimits(input.limits, agent.limits);
  const settings = resolveModelSettings({ task: input.modelSettings, agent: agent.agentSettings, runtime: agent.runtimeSettings, provider: target.providerSettings });
  const filtered = filterProviderSettings({ provider: target.provider, settings });
  const stream = createEventStream<AigentEvent, TaskResult>();
  const emit = (event: AigentEvent): void => stream.push(event);
  const { control, stop, dispose } = createRunControl({ signal: input.signal, timeoutMs });

  async function execute(): Promise<void> {
    const startedAt = clock.now();
    for (const message of filtered.warnings) emit({ type: 'warning', message });
    let result: TaskResult;
    try {
      result = await runTask({
        runId, agentName, instanceId, prompt, input, registry, clock, control, emit,
        target: { provider: target.provider, model: target.model, settings: filtered.settings },
        showThinking: settings.showThinking ?? true,
        limits: { maxTurns, maxToolCalls },
      });
    } finally {
      dispose();
    }
    if (input.disableTelemetry !== true) {
      const record = buildRunRecord({ input, result, agent: { agentVersion, model: target.reference, settings, version }, startedAt });
      const warning = await writeRunRecord({ store, writeQueue, record });
      if (warning != null) emit({ type: 'warning', message: warning });
    }
    // `done` is last and only after the record is flushed, so a consumer that sees it can read the record.
    emit({ type: 'done', status: result.status });
    stream.finish(result);
  }

  // Deferred so the caller can attach iterators first (events are buffered regardless).
  queueMicrotask(() => { execute().catch(error => stream.fail(error)); });

  const run: TaskRun = Object.assign(stream.run, { runId, stop, cancel: () => stop({ mode: 'immediate' }) });
  return run;
}
