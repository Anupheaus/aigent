import type { TaskResultData } from '../core/agent-types.js';
import type { ModelSettings } from '../core/model-settings.js';
import type { ProviderTarget } from '../core/open-turn-stream.js';
import type { TaskInput } from '../core/task-input.js';
import { RUN_RECORD_SCHEMA_VERSION } from './run-record.js';
import type { OutcomeSummary, RecordMeta, RunRecord, RunRecordFallback, RuntimeOnlySettings, TraceRecord, TraceStep } from './run-record.js';
import type { MeasuredTimings } from './run-timer.js';

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

/** What the run's telemetry collected, plus when and how it is stored. */
export interface RunFacts {
  timings: MeasuredTimings;
  steps: TraceStep[];
  /** False leaves the task, answer and argument values out. */
  captureContent: boolean;
  recordedAt: number;
  expiresAt?: number;
}

export interface BuildRunRecordsParams {
  input: TaskInput;
  result: TaskResultData;
  agent: RunRecordAgent;
  targets: RunRecordTargets;
  facts: RunFacts;
}

export interface RunRecords {
  /** The identity every record of this run carries. */
  meta: RecordMeta;
  run: RunRecord;
  trace: TraceRecord;
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

/** The agent's own success claims over its steps (user verdicts are scored separately and win). */
function summariseOutcomes(steps: TraceStep[]): OutcomeSummary {
  const outcomes = steps.flatMap(({ outcome }) => (outcome == null ? [] : [outcome]));
  return { claimedSuccess: outcomes.filter(({ success }) => success).length, claimedFailure: outcomes.filter(({ success }) => !success).length };
}

/** Inner `aigent_multi` calls run inside their parent's time, so only top-level steps add up to tool time. */
function topLevelToolMs(steps: TraceStep[]): number {
  return steps.filter(({ parentCallId }) => parentCallId == null).reduce((total, { durationMs }) => total + durationMs, 0);
}

function recordMeta(params: BuildRunRecordsParams): RecordMeta {
  const { input: { scope }, result: { runId, agentName, instanceId }, agent: { agentVersion }, facts: { recordedAt, expiresAt } } = params;
  return {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION, runId, agentName, instanceId, mode: 'task', agentVersion,
    ...(scope == null ? {} : { scope }), recordedAt, ...(expiresAt == null ? {} : { expiresAt }),
  };
}

/** The `runs` and `traces` documents of a finished run. */
export function buildRunRecords(params: BuildRunRecordsParams): RunRecords {
  const { input: { label, unattended = false, task }, result: { responseId, status, usage, errors, answer }, agent: { version }, targets, facts } = params;
  const { primary, fallbacks, runtimeSettings } = targets;
  const { timings, steps, captureContent } = facts;
  const meta = recordMeta(params);
  const runtime = runtimeOnly(runtimeSettings);
  const run: RunRecord = {
    ...meta, responseId,
    ...(version == null ? {} : { version }),
    ...(label == null ? {} : { label }),
    model: primary.label, ...sentSettings(primary),
    ...(runtime == null ? {} : { runtimeSettings: runtime }),
    ...(fallbacks.length === 0 ? {} : { fallbacks: fallbacks.map(target => ({ model: target.label, ...sentSettings(target) })) }),
    unattended, status, usage,
    timings: { ...timings, durationMs: usage.durationMs, toolMs: topLevelToolMs(steps) },
    stepCount: steps.length,
    failureCount: errors.length,
    outcomeSummary: summariseOutcomes(steps),
    ...(captureContent ? { task, answer } : {}),
  };
  return { meta, run, trace: { ...meta, steps } };
}
