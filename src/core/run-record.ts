import type { Store } from '../store/store-types.js';
import type { WriteQueue } from '../store/write-queue.js';
import type { TaskResult, TaskUsage } from './agent-types.js';
import type { TaskStatus } from './aigent-events.js';
import { describeError } from './describe-value.js';
import type { ModelSettings } from './model-settings.js';
import type { TaskInput } from './task-input.js';

const RUNS_COLLECTION = 'runs';

/** One document in the `runs` collection, keyed by run id. */
export interface RunRecord {
  runId: string;
  agentName: string;
  instanceId: string;
  /** The agent's version hash (see `Agent.agentVersion`). */
  agentVersion: string;
  /** The agent's `provider:model`. */
  model: string;
  /** The settings the run resolved (task > agent > runtime > provider), before any provider dropped some. */
  settings: ModelSettings;
  /** The agent definition's human version label, when it has one. */
  version?: string;
  label?: string;
  scope?: Record<string, string>;
  status: TaskStatus;
  usage: TaskUsage;
  startedAt: number;
}

/** What identifies the agent and its configuration on every record. */
export type RunRecordAgent = Pick<RunRecord, 'agentVersion' | 'model' | 'settings' | 'version'>;

export interface BuildRunRecordParams {
  input: TaskInput;
  result: TaskResult;
  agent: RunRecordAgent;
  startedAt: number;
}

export interface WriteRunRecordParams {
  store?: Store;
  writeQueue: WriteQueue;
  record: RunRecord;
}

export function buildRunRecord(params: BuildRunRecordParams): RunRecord {
  const { input: { label, scope }, result: { runId, agentName, instanceId, status, usage }, agent: { agentVersion, model, settings, version }, startedAt } = params;
  const record: RunRecord = { runId, agentName, instanceId, agentVersion, model, settings, status, usage, startedAt };
  if (version != null) record.version = version;
  if (label != null) record.label = label;
  if (scope != null) record.scope = scope;
  return record;
}

/** Writes the run record through the agent's write queue. Returns a warning instead of throwing: telemetry must not fail a finished task. */
export async function writeRunRecord(params: WriteRunRecordParams): Promise<string | undefined> {
  const { store, writeQueue, record } = params;
  if (store == null) return undefined;
  const { runId, agentName } = record;
  try {
    const isWritten = await writeQueue.enqueue(agentName, () => store.compareAndSet({ collection: RUNS_COLLECTION, key: runId, expectedVersion: undefined, value: record }));
    return isWritten ? undefined : `Run record '${runId}' for agent '${agentName}' was not written: a record with that id already exists`;
  } catch (error) {
    return `Run record '${runId}' for agent '${agentName}' could not be written: ${describeError(error)}`;
  }
}
