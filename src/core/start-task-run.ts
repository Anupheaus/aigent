import type { Provider } from '../providers/provider-types.js';
import type { Store } from '../store/store-types.js';
import type { WriteQueue } from '../store/write-queue.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { AigentEvent, TaskStatus } from './aigent-events.js';
import { DEFAULT_LIMITS } from './agent-types.js';
import type { TaskResult, TaskRun, TaskUsage } from './agent-types.js';
import { createEventStream } from './event-stream.js';
import { createRunControl } from './run-control.js';
import { runTask } from './run-task.js';
import type { Clock, IdGenerator } from './runtime-services.js';
import type { PromptPersona } from './system-prompt.js';
import type { TaskInput, TaskLimits } from './task-input.js';

const RUNS_COLLECTION = 'runs';

/** An agent definition after validation: provider resolved, registry built. */
export interface ResolvedAgent {
  name: string;
  instanceId: string;
  model: string;
  provider: Provider;
  prompt: PromptPersona;
  registry: ToolRegistry;
  limits?: TaskLimits;
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

interface RunRecord {
  runId: string;
  agentName: string;
  instanceId: string;
  label?: string;
  scope?: Record<string, string>;
  status: TaskStatus;
  usage: TaskUsage;
  startedAt: number;
}

interface RecordRunParams {
  services: RuntimeServices;
  record: RunRecord;
}

interface BuildRecordParams {
  input: TaskInput;
  result: TaskResult;
  startedAt: number;
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

/** Writes the run record through the agent's write queue. Returns a warning instead of throwing: telemetry must not fail a finished task. */
async function recordRun(params: RecordRunParams): Promise<string | undefined> {
  const { services: { store, writeQueue }, record } = params;
  if (store == null) return undefined;
  const { runId, agentName } = record;
  try {
    const isWritten = await writeQueue.enqueue(agentName, () => store.compareAndSet({ collection: RUNS_COLLECTION, key: runId, expectedVersion: undefined, value: record }));
    return isWritten ? undefined : `Run record '${runId}' for agent '${agentName}' was not written: a record with that id already exists`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `Run record '${runId}' for agent '${agentName}' could not be written: ${reason}`;
  }
}

function buildRecord(params: BuildRecordParams): RunRecord {
  const { input: { label, scope }, result: { runId, agentName, instanceId, status, usage }, startedAt } = params;
  const record: RunRecord = { runId, agentName, instanceId, status, usage, startedAt };
  if (label != null) record.label = label;
  if (scope != null) record.scope = scope;
  return record;
}

/** Starts a task in the background and returns its awaitable, iterable, stoppable handle. */
export function startTaskRun(params: StartTaskRunParams): TaskRun {
  const { agent, services, input } = params;
  const { name: agentName, instanceId, model, provider, prompt, registry } = agent;
  const { clock, ids } = services;
  const runId = ids.next('run');
  const { maxTurns, maxToolCalls, timeoutMs } = resolveLimits(input.limits, agent.limits);
  const stream = createEventStream<AigentEvent, TaskResult>();
  const emit = (event: AigentEvent): void => stream.push(event);
  const { control, stop, dispose } = createRunControl({ signal: input.signal, timeoutMs });

  async function execute(): Promise<void> {
    const startedAt = clock.now();
    let result: TaskResult;
    try {
      result = await runTask({ runId, agentName, instanceId, model, provider, prompt, input, registry, limits: { maxTurns, maxToolCalls }, clock, control, emit });
    } finally {
      dispose();
    }
    if (input.disableTelemetry !== true) {
      const warning = await recordRun({ services, record: buildRecord({ input, result, startedAt }) });
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
