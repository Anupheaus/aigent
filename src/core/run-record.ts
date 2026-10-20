import type { ProviderSettings } from '../providers/provider-types.js';
import type { Store } from '../store/store-types.js';
import type { WriteQueue } from '../store/write-queue.js';
import type { TaskResult, TaskUsage } from './agent-types.js';
import type { TaskStatus } from './aigent-events.js';
import { describeError } from './describe-value.js';
import type { ModelSettings } from './model-settings.js';
import type { ProviderTarget } from './open-turn-stream.js';
import type { TaskInput } from './task-input.js';

const RUNS_COLLECTION = 'runs';

/** The runtime-only settings: they shape the run but are never sent to a provider. */
export type RuntimeOnlySettings = Pick<ModelSettings, 'contextSize' | 'showThinking'>;

/** A fallback model the run used, with what it was sent. */
export interface RunRecordFallback {
  /** `provider:model`. */
  model: string;
  /** The settings this model was sent (its own `providerOptions` entry included); `{}` when none. */
  settings: ProviderSettings;
  /** Resolved settings this model's provider left out. */
  droppedSettings?: (keyof ProviderSettings)[];
}

/** One document in the `runs` collection, keyed by run id. */
export interface RunRecord {
  runId: string;
  agentName: string;
  instanceId: string;
  /** The agent's version hash (see `Agent.agentVersion`). */
  agentVersion: string;
  /** The agent's `provider:model`. */
  model: string;
  /**
   * The settings the agent's model was sent: resolved task > agent > runtime > provider, then filtered for its
   * provider, with only that provider's `providerOptions` entry. `{}` when none. `providerOptions` are stored as
   * configured, so keep secrets and personal data out of them.
   */
  settings: ProviderSettings;
  /** Resolved settings the agent's provider left out (each also produced a `warning`). */
  droppedSettings?: (keyof ProviderSettings)[];
  /** `contextSize` / `showThinking` when set: run configuration that is never sent. */
  runtimeSettings?: RuntimeOnlySettings;
  /** Fallback models the run actually used, in the order it reached them. */
  fallbacks?: RunRecordFallback[];
  /** The agent definition's human version label, when it has one. */
  version?: string;
  label?: string;
  scope?: Record<string, string>;
  status: TaskStatus;
  usage: TaskUsage;
  startedAt: number;
}

/** What identifies the agent on every record. */
export type RunRecordAgent = Pick<RunRecord, 'agentVersion' | 'version'>;

/** The models the run used and its resolved settings. */
export interface RunRecordTargets {
  primary: ProviderTarget;
  /** Only the fallbacks the run reached. */
  fallbacks: ProviderTarget[];
  /** The run's fully resolved settings; only the runtime-only fields are recorded from it. */
  runtimeSettings: ModelSettings;
}

export interface BuildRunRecordParams {
  input: TaskInput;
  result: TaskResult;
  agent: RunRecordAgent;
  targets: RunRecordTargets;
  startedAt: number;
}

export interface WriteRunRecordParams {
  store?: Store;
  writeQueue: WriteQueue;
  record: RunRecord;
}

function sentSettings(target: ProviderTarget): Pick<RunRecordFallback, 'settings' | 'droppedSettings'> {
  const { settings = {}, dropped } = target;
  return { settings, ...(dropped.length === 0 ? {} : { droppedSettings: dropped }) };
}

function runtimeOnly(settings: ModelSettings): RuntimeOnlySettings | undefined {
  const { contextSize, showThinking } = settings;
  const picked: RuntimeOnlySettings = { ...(contextSize == null ? {} : { contextSize }), ...(showThinking == null ? {} : { showThinking }) };
  return Object.keys(picked).length === 0 ? undefined : picked;
}

export function buildRunRecord(params: BuildRunRecordParams): RunRecord {
  const { input: { label, scope }, result: { runId, agentName, instanceId, status, usage }, agent: { agentVersion, version }, targets, startedAt } = params;
  const { primary, fallbacks, runtimeSettings } = targets;
  const record: RunRecord = { runId, agentName, instanceId, agentVersion, model: primary.label, ...sentSettings(primary), status, usage, startedAt };
  const runtime = runtimeOnly(runtimeSettings);
  if (runtime != null) record.runtimeSettings = runtime;
  if (fallbacks.length > 0) record.fallbacks = fallbacks.map(target => ({ model: target.label, ...sentSettings(target) }));
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
