import type { CompressionRecord } from '../compression/compressor-types.js';
import type { Usage } from '../providers/provider-types.js';
import { topLevelToolMs } from '../telemetry/build-run-records.js';
import type { RunRecordTargets } from '../telemetry/build-run-records.js';
import type { RunMode, RunTimings } from '../telemetry/run-record.js';
import type { AigentEvent } from './aigent-events.js';
import { DEFAULT_LIMITS } from './agent-types.js';
import type { TaskResult, TaskResultData } from './agent-types.js';
import type { RunCompression } from './run-compression.js';
import { persistRunTelemetry } from './run-telemetry.js';
import type { RunTelemetry } from './run-turn.js';
import type { RunMemoryTotals } from './run-memory.js';
import type { ResolvedAgent, RuntimeServices } from './start-task-run.js';
import type { TaskInput, TaskLimits } from './task-input.js';

export interface ResolvedLimits {
  maxTurns: number;
  maxToolCalls: number;
  timeoutMs?: number;
}

/** Task limits win over agent limits, field by field, then the library defaults. */
export function resolveLimits(taskLimits: TaskLimits | undefined, agentLimits: TaskLimits | undefined): ResolvedLimits {
  return {
    maxTurns: taskLimits?.maxTurns ?? agentLimits?.maxTurns ?? DEFAULT_LIMITS.maxTurns,
    maxToolCalls: taskLimits?.maxToolCalls ?? agentLimits?.maxToolCalls ?? DEFAULT_LIMITS.maxToolCalls,
    timeoutMs: taskLimits?.timeoutMs ?? agentLimits?.timeoutMs,
  };
}

/** A finished run's figures, the same ones its run record stores (chat message meta is built from them). */
export interface RunSummary {
  result: TaskResultData;
  timings: RunTimings;
  /** Steps served from the tool-result cache. */
  cacheHits: number;
  /** `provider:model` of the agent's model. */
  model: string;
  /** Absent without a price for `model`. */
  costUsd?: number;
}

export interface FinishAgentRunParams {
  agent: ResolvedAgent;
  services: RuntimeServices;
  input: TaskInput;
  telemetry: RunTelemetry;
  result: TaskResultData;
  targets: RunRecordTargets;
  mode: RunMode;
  compression?: RunCompression;
  /** The run's cost at its model's price; 0 without one. */
  price(usage: Usage): number;
  emit(event: AigentEvent): void;
  onFinished?(summary: RunSummary): void;
  /** With memory on: what the run's saves came to, and its scope key. */
  memory?: RunMemoryTotals & { scopeKey: string };
}

/** Adds `feedback` as a non-enumerable method, so results stay plain data for `toEqual`, JSON and structured clones. */
function withFeedbackShortcut(params: { result: TaskResultData; submitFeedback: RuntimeServices['submitFeedback'] }): TaskResult {
  const { result, submitFeedback } = params;
  const { responseId } = result;
  const feedback: TaskResult['feedback'] = rating => submitFeedback({ ...rating, responseId });
  return Object.defineProperty(result, 'feedback', { value: feedback, enumerable: false }) as TaskResult;
}

function summarise(params: FinishAgentRunParams): RunSummary {
  const { telemetry: { timer, recorder }, result, targets: { primary }, services: { pricing } } = params;
  const steps = recorder.steps();
  const timings: RunTimings = { ...timer.snapshot(), durationMs: result.usage.durationMs, toolMs: topLevelToolMs(steps) };
  const isPriced = pricing?.[primary.label] != null;
  return {
    result, timings, cacheHits: steps.filter(({ cacheHit }) => cacheHit === true).length, model: primary.label,
    ...(isPriced ? { costUsd: params.price(result.usage) } : {}),
  };
}

/** Takes the run's agent feedback, writes its records (unless telemetry is off) and returns the consumer's result. */
export async function finishAgentRun(params: FinishAgentRunParams): Promise<TaskResult> {
  const { agent: { feedbackCollector, agentVersion, version }, services, input, telemetry, result, targets, mode, compression, emit, onFinished, memory } = params;
  // Taken even when nothing is stored, so a disabled run's entries are not kept in memory.
  const feedback = feedbackCollector?.take(result.runId) ?? [];
  onFinished?.(summarise(params));
  // disableTelemetry runs (evals, tests) write nothing at all, so they never reach scores.
  if (input.disableTelemetry !== true) {
    const warning = await persistRunTelemetry({
      now: () => services.clock.now(), telemetry, settings: services.telemetry, feedback,
      run: {
        input, mode, result, agent: { agentVersion, version }, targets,
        ...(compression == null || compression.log.length === 0 ? {} : { compression: compression.log }),
        ...(memory == null ? {} : { memory }),
      },
    });
    if (warning != null) emit({ type: 'warning', message: warning });
  }
  return withFeedbackShortcut({ result, submitFeedback: services.submitFeedback });
}
