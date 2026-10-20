import type { ToolCache } from '../cache/cache-types.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import { addErrorDetails } from '../tools/tool-error-detail.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { describeError } from './describe-value.js';
import type { AigentEvent, TaskStatus } from './aigent-events.js';
import type { TaskResultData, TaskUsage } from './agent-types.js';
import type { Compactor } from '../context/compactor.js';
import type { RunShaping } from './run-shaping.js';
import type { RunVolatile } from './run-volatile.js';
import type { RunPlanning } from '../planning/run-planning.js';
import { finalStatus, planningResult, syncPinned } from './run-planning-setup.js';
import { createRunCompaction } from './run-compaction.js';
import type { RunCompactionSettings } from './run-compaction.js';
import { appendContextMessages, createRunContext } from './run-context.js';
import { createRunOriginals } from './run-originals.js';
import { turnMessages } from './turn-messages.js';
import { runTurn } from './run-turn.js';
import { settleActivities } from './settle-activities.js';
import type { TurnRouting } from './open-turn-stream.js';
import type { RunTelemetry, RunTotals, TurnStreamResult, TurnWork } from './run-turn.js';
import type { Clock } from './runtime-services.js';
import { compressCommitted } from './run-compression.js';
import type { RunCompression } from './run-compression.js';

export type AbortReason = 'user' | 'timeout';

/** Mutable control surface shared between the run and its `stop`/`cancel` handles. */
export interface RunControl {
  abortController: AbortController;
  isGracefulStopRequested(): boolean;
  /** Why the run was aborted, set before aborting. */
  abortReason(): AbortReason | undefined;
}

export interface RunTaskParams {
  runId: string;
  /** Stable id of this run's answer, for user feedback. */
  responseId: string;
  agentName: string;
  instanceId: string;
  routing: TurnRouting;
  /** Whether `thinking-delta` events are emitted. */
  showThinking: boolean;
  /** The system prompt as sent (compression applied). */
  systemPrompt: string;
  /** The task brief as sent (compression applied). */
  brief: string;
  /** Present when the agent compresses; tool results are compressed as they are committed. */
  compression?: RunCompression;
  registry: ToolRegistry;
  limits: { maxTurns: number; maxToolCalls: number };
  clock: Clock;
  control: RunControl;
  telemetry: RunTelemetry;
  /** The runtime's tool-result cache; absent when caching is off. */
  cache?: ToolCache;
  /** The run's shaping; absent when nothing can be shaped. */
  shaping?: RunShaping;
  /** The run's volatile block, minus the limits this function adds. */
  volatile: Omit<RunVolatile, 'maxTurns'>;
  /** The run's plan and todo list. */
  planning: RunPlanning;
  /** When and how the run compacts its history. */
  compaction: RunCompactionSettings;
  emit(event: AigentEvent): void;
}

interface DrainWorkParams {
  work: TurnWork;
  signal: AbortSignal;
  emit(event: AigentEvent): void;
}

/** `signal.reason` when the run aborts its own tools because the provider failed. */
const PROVIDER_FAILED_ABORT_REASON = 'the run failed because the provider failed';

/** How long a turn waits, after its tools finished, for activity renderers to settle before abandoning them. */
const ACTIVITY_SETTLE_GRACE_MS = 1_000;

/** A run aborted by its timeout reached a limit; any other abort is a cancellation. */
function abortedStatus(control: RunControl): TaskStatus {
  return control.abortReason() === 'timeout' ? 'limit_reached' : 'cancelled';
}

/**
 * Every failure of a turn: failed calls, plus failures nested inside successful aggregate results (batch items,
 * aigent_multi calls), taken from the full results so a truncated result never hides one.
 */
function failedDetails(executed: ExecutedToolCall[]): ToolErrorDetail[] {
  return executed.flatMap(({ envelope, nested }) => {
    if (!envelope.ok) return [envelope.error];
    return nested.map(detail => addErrorDetails(detail, { parentCallId: envelope.id }));
  });
}

/** Tool calls per model request; 0 before any request, so a run that never reached the model does not divide by zero. */
function toolCallsPerTurn(totals: RunTotals): number {
  const { turns, toolCalls } = totals;
  return turns === 0 ? 0 : toolCalls / turns;
}

/** The compaction figures for `TaskUsage`, only when the run compacted (or paid for a summary). */
function compactionUsage(params: { compactor: Compactor; totals: RunTotals }): Pick<TaskUsage, 'compactions' | 'compactionTokens' | 'compactionTokensSaved'> {
  const { compactor, totals: { compactionTokens } } = params;
  const { compactions, tokensSaved } = compactor.stats();
  if (compactions === 0 && compactionTokens === 0) return {};
  return { compactions, compactionTokens, compactionTokensSaved: tokensSaved };
}

/**
 * Waits for everything a turn started. Executions race the run's signal (tools in `runTool`, cache lookups and the
 * flights they wait on in `boundedLookup`; a miss always releases its flight) and activity renderers are bounded by
 * `settleActivities`, so this always settles promptly, even after an abort or with a renderer that never finishes.
 */
async function drainWork(params: DrainWorkParams): Promise<ExecutedToolCall[]> {
  const { work, signal, emit } = params;
  const { executions, activities, activityController } = work;
  const executed = await Promise.all(executions);
  const isSettled = await settleActivities({ activities, signal, graceMs: ACTIVITY_SETTLE_GRACE_MS });
  if (!isSettled) {
    activityController.abort();
    // After an abort, cutting renderers off is expected rather than a problem worth reporting.
    if (!signal.aborted) emit({ type: 'warning', message: `Tool activity renderers for this turn (${activities.length} started) did not settle within ${ACTIVITY_SETTLE_GRACE_MS} ms after their tools finished; their activity updates were stopped` });
  }
  return executed;
}

/** Runs the agent loop until the model answers, a limit is hit, the run is stopped or the provider fails. Never rejects for those cases. */
export async function runTask(params: RunTaskParams): Promise<TaskResultData> {
  const { runId, responseId, agentName, instanceId, routing, showThinking, systemPrompt, brief, limits, clock, control, telemetry, cache, shaping, planning, emit } = params;
  const volatile: RunVolatile = { ...params.volatile, maxTurns: limits.maxTurns };
  const { abortController } = control;
  const { signal } = abortController;
  const startedAt = clock.now();
  const context = createRunContext({
    runId, createdAt: startedAt,
    initial: [{ kind: 'system', message: { role: 'system', text: systemPrompt } }, { kind: 'brief', message: { role: 'user', text: brief } }],
  });
  const totals: RunTotals = { usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, turns: 0, toolCalls: 0, retries: 0, fallbacks: 0, compactionTokens: 0 };
  const originals = createRunOriginals({
    registry: params.registry, isFeedbackEnabled: telemetry.feedback.isEnabled, ...(shaping == null ? {} : { shaping }), ...(params.compression == null ? {} : { compression: params.compression.settings }),
  });
  const compactor = createRunCompaction({ settings: params.compaction, context, originals, volatile, clock, totals, signal, emit });
  const errors: ToolErrorDetail[] = [];
  let answer = '';
  let status: TaskStatus = 'completed';
  let failure: string | undefined;

  for (;;) {
    // Covers an abort that landed while tools ran after the stream had already finished.
    if (signal.aborted) { status = abortedStatus(control); break; }
    if (control.isGracefulStopRequested()) { status = 'stopped'; break; }
    if (totals.turns >= limits.maxTurns) { status = 'limit_reached'; break; }
    totals.turns += 1;
    syncPinned({ context, planning, now: clock.now() });
    try {
      // A turn boundary: every result of the previous round is stored, so no call can be separated from its result.
      await compactor.beforeTurn({ remainingTurns: limits.maxTurns - totals.turns + 1 });
    } catch (error) {
      if (signal.aborted) { status = abortedStatus(control); break; }
      status = 'failed';
      failure = describeError(error);
      emit({ type: 'error', message: failure });
      break;
    }
    const registry = originals.registry();

    const work: TurnWork = { executions: [], activities: [], activityController: new AbortController() };
    let turn: TurnStreamResult;
    const endTurn = telemetry.timer.startTurn();
    try {
      turn = await runTurn({
        runId, agentName, instanceId, routing, showThinking, registry, maxToolCalls: limits.maxToolCalls, clock, signal, context, totals, work, telemetry, emit, volatile, planning,
        ...(cache == null ? {} : { cache }),
        ...(shaping == null ? {} : { shaping }),
      });
      endTurn();
    } catch (error) {
      endTurn();
      // Only the run's own signal means it was aborted; a provider error that merely carries the 'aborted' code is a provider failure.
      if (signal.aborted) {
        status = abortedStatus(control);
      } else {
        status = 'failed';
        failure = describeError(error);
        emit({ type: 'error', message: failure });
        // Tools dispatched mid-stream must not outlive a failed run.
        abortController.abort(PROVIDER_FAILED_ABORT_REASON);
      }
      errors.push(...failedDetails(await drainWork({ work, signal, emit })));
      break;
    }

    const drained = await drainWork({ work, signal, emit });
    const executed = await compressCommitted({ executed: drained, originals, clock, signal, emit, ...(params.compression == null ? {} : { compression: params.compression }) });
    appendContextMessages({ context, messages: turnMessages({ turn, executed, registry }), createdAt: clock.now() });
    errors.push(...failedDetails(executed));
    if (turn.calls.length === 0) {
      answer = turn.visible.trim();
      if (turn.finishReason === 'length') status = 'incomplete';
      break;
    }
  }

  const { usage, turns, toolCalls, retries, fallbacks } = totals;
  const result: TaskResultData = {
    ...planningResult(planning),
    status: finalStatus({ status, planning }), answer, runId, responseId, agentName, instanceId, errors,
    usage: {
      ...usage, turns, toolCalls, toolCallsPerTurn: toolCallsPerTurn(totals), retries, fallbacks, durationMs: clock.now() - startedAt,
      ...(context.peakTokens > 0 ? { contextTokensPeak: context.peakTokens } : {}),
      ...compactionUsage({ compactor, totals }),
    },
  };
  if (failure != null) result.failure = failure;
  if (status === 'stopped') result.stopMode = 'graceful';
  if (status === 'cancelled') result.stopMode = 'immediate';
  return result;
}
