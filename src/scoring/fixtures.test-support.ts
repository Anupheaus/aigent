import type { UserRating } from '../feedback/feedback-records.js';
import type { RunRecord, RunTrace, TraceStep } from '../telemetry/run-record.js';

/** The fields scoring and analysis read, each with a plain default. */
export interface FixtureRunParams {
  startedAt: number;
  runId?: string;
  agentName?: string;
  agentVersion?: string;
  version?: string;
  instanceId?: string;
  model?: string;
  label?: string;
  unattended?: boolean;
  status?: RunRecord['status'];
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  turns?: number;
  toolCalls?: number;
  retries?: number;
  failureCount?: number;
  claimedSuccess?: number;
  claimedFailure?: number;
  userVerdict?: UserRating;
  toolUse?: RunRecord['toolUse'];
  task?: string;
}

const RUN_ID_WIDTH = 4;

/** A stored run record with known numbers; ids follow `startedAt` so ordering is obvious. */
export function fixtureRun(params: FixtureRunParams): RunRecord {
  const {
    startedAt, runId = `run_${String(startedAt).padStart(RUN_ID_WIDTH, '0')}`, agentName = 'helper', agentVersion = 'v1', version, instanceId = 'i1', model = 'fake:m',
    label, unattended = false, status = 'completed', durationMs = 1_000, inputTokens = 1_000, outputTokens = 0, cachedTokens = 0, turns = 2, toolCalls = 4,
    retries = 0, failureCount = 0, claimedSuccess = 0, claimedFailure = 0, userVerdict, toolUse = { calls: toolCalls, items: toolCalls, repeats: 0 }, task,
  } = params;
  return {
    schemaVersion: 1, runId, responseId: `resp_${runId}`, agentName, instanceId, mode: 'task', agentVersion, recordedAt: startedAt + durationMs,
    ...(version == null ? {} : { version }), ...(label == null ? {} : { label }), model, settings: {}, unattended, status,
    usage: { inputTokens, outputTokens, cachedTokens, turns, toolCalls, toolCallsPerTurn: turns === 0 ? 0 : toolCalls / turns, retries, fallbacks: 0, durationMs },
    timings: { startedAt, durationMs, modelMs: durationMs, toolMs: 0, queuedMs: 0 },
    stepCount: toolUse.calls, failureCount, outcomeSummary: { claimedSuccess, claimedFailure }, toolUse,
    ...(userVerdict == null ? {} : { userVerdict }), ...(task == null ? {} : { task }),
  };
}

export type FixtureStepParams = Partial<TraceStep> & Pick<TraceStep, 'tool'>;

/** Trace steps in order: index, call id and start time follow position unless given. */
export function fixtureSteps(steps: FixtureStepParams[]): TraceStep[] {
  return steps.map((step, index) => ({
    index, turn: 1, callId: `c${index}`, argsSummary: '{}', ok: true, resultBytes: 40, resultTokens: 10, truncated: false, durationMs: 100, startedAtMs: index * 10,
    ...step,
  }));
}

/** A run with its steps. */
export function fixtureTrace(params: { run: FixtureRunParams; steps?: FixtureStepParams[] }): RunTrace {
  const { run, steps = [] } = params;
  return { run: fixtureRun(run), steps: fixtureSteps(steps) };
}

/** `count` runs one millisecond apart from `firstStartedAt`, all with the same overrides. */
export function fixtureSeries(params: { count: number; firstStartedAt: number; run?: Omit<FixtureRunParams, 'startedAt'> }): RunRecord[] {
  const { count, firstStartedAt, run = {} } = params;
  return Array.from({ length: count }, (_, offset) => fixtureRun({ ...run, startedAt: firstStartedAt + offset }));
}
