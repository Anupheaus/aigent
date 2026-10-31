import type { TaskResultData } from '../core/agent-types.js';
import { storedDecisions } from '../guardrails/stored-decisions.js';
import { storedEffects } from '../effects/planned-effects.js';
import type { ModelSettings } from '../core/model-settings.js';
import type { ProviderTarget } from '../core/open-turn-stream.js';
import type { TaskInput } from '../core/task-input.js';
import type { CompressionRecord } from '../compression/compressor-types.js';
import { RUN_RECORD_SCHEMA_VERSION } from './run-record.js';
import type { OutcomeSummary, RecordMeta, RunMode, RunRecord, RunRecordFallback, RuntimeOnlySettings, ToolUse, TraceRecord, TraceStep } from './run-record.js';
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
  toolUse: ToolUse;
  /** False leaves the task, answer and argument values out. */
  captureContent: boolean;
  recordedAt: number;
  expiresAt?: number;
}

export interface BuildRunRecordsParams {
  input: TaskInput;
  /** Default `task`. */
  mode?: RunMode;
  /** Every compression the run used, when the agent compresses. */
  compression?: CompressionRecord[];
  /** With memory on: the run's saved and evicted counts, and its scope key. */
  memory?: { saved: number; evicted: number; scopeKey: string };
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
export function topLevelToolMs(steps: TraceStep[]): number {
  return steps.filter(({ parentCallId }) => parentCallId == null).reduce((total, { durationMs }) => total + durationMs, 0);
}

function recordMeta(params: BuildRunRecordsParams): RecordMeta {
  const { input: { scope }, mode = 'task', result: { runId, agentName, instanceId }, agent: { agentVersion }, facts: { recordedAt, expiresAt } } = params;
  return {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION, runId, agentName, instanceId, mode, agentVersion,
    ...(scope == null ? {} : { scope }), recordedAt, ...(expiresAt == null ? {} : { expiresAt }),
  };
}

/** The `runs` and `traces` documents of a finished run. */
export function buildRunRecords(params: BuildRunRecordsParams): RunRecords {
  const { input: { label, unattended = false, task, dryRun, parent }, result: { responseId, status, usage, errors, answer, plan, todo, guardrails = [], plannedEffects }, agent: { version }, targets, facts, compression, memory } = params;
  const { primary, fallbacks, runtimeSettings } = targets;
  const { timings, steps, toolUse, captureContent } = facts;
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
    ...(parent == null ? {} : { parent }),
    timings: { ...timings, durationMs: usage.durationMs, toolMs: topLevelToolMs(steps) },
    stepCount: steps.length,
    failureCount: errors.length,
    outcomeSummary: summariseOutcomes(steps),
    toolUse,
    ...(captureContent ? { task, answer } : {}),
    // Without content capture only ids and statuses are kept: labels, criteria and evidence are content.
    ...(plan == null ? {} : { plan: captureContent ? plan : plan.map(({ id, status }) => ({ id, status })) }),
    ...(todo == null ? {} : { todo: captureContent ? todo : todo.map(({ id, status }) => ({ id, status })) }),
    ...(compression == null || compression.length === 0 ? {} : { compression }),
    ...(guardrails.length === 0 ? {} : { guardrails: storedDecisions({ decisions: guardrails, captureContent }) }),
    ...(dryRun === true ? { dryRun, plannedEffects: storedEffects({ effects: plannedEffects ?? [], captureContent }) } : {}),
    ...(memory == null ? {} : { memorySaved: memory.saved, memoryEvicted: memory.evicted, memoryScopeKey: memory.scopeKey }),
  };
  return { meta, run, trace: { ...meta, steps } };
}
