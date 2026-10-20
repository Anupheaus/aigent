import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { OutcomeSource, StepOutcome, TraceStep } from './run-record.js';
import { digestArgs } from './digest-args.js';
import { summariseArgs } from './summarise-args.js';
import { storedDecisions } from '../guardrails/stored-decisions.js';

export interface BeginStepParams {
  /** 1-based model request that asked for the call. */
  turn: number;
  callId: string;
  /** Set for inner `aigent_multi` calls. */
  parentCallId?: string;
  tool: string;
  /** The arguments the tool is run with. */
  args: unknown;
}

/** Records how a begun step ended; later calls are ignored. */
export type FinishStep = (executed: ExecutedToolCall) => void;

export interface AttachOutcomeParams {
  outcome: Omit<StepOutcome, 'source'>;
  source: OutcomeSource;
  /** The model request the report came from: it can only be about results the model saw, i.e. steps of earlier turns. */
  turn: number;
}

/** The step a report would attach to. */
export interface OutcomeTarget {
  index: number;
  turn: number;
  hasOutcome: boolean;
}

export interface TraceRecorder {
  /** Starts a step (its index is its start order) and returns the function that finishes it. */
  begin(params: BeginStepParams): FinishStep;
  /**
   * Attaches the agent's verdict to the last top-level work step of an earlier turn than the report's (steps of the
   * report's own turn, e.g. parallel siblings, have results the model has not seen). A step keeps one outcome: the
   * first `previous` report wins over later ones, and a directive replaces a `previous` report but never the other way round.
   */
  attachOutcome(params: AttachOutcomeParams): void;
  /** The step a report from `turn` would attach to, if any. */
  outcomeTarget(turn: number): OutcomeTarget | undefined;
  /** Every step so far in start order; a step still running is reported as aborted. */
  steps(): TraceStep[];
}

export interface CreateTraceRecorderParams {
  now(): number;
  /** Whether argument values (`args`, a value-bearing `argsSummary`) and outcome answers are kept. */
  captureContent: boolean;
  /** Salts each step's `argsHash` (the run id). */
  argsDigestKey: string;
  /** Tools whose steps never receive outcomes (commentary such as `aigent_feedback`, not work). */
  nonOutcomeTools?: string[];
}

/** Marks a step that never finished, e.g. an inner call cut off when its `aigent_multi` call timed out. */
const UNFINISHED_ERROR_CODE = 'step_unfinished';

function finishedFields(executed: ExecutedToolCall): Partial<TraceStep> {
  const { envelope, durationMs, size: { resultBytes, resultTokens, truncated }, items, cacheHit, savedMs, shaped } = executed;
  return {
    ok: envelope.ok,
    ...(envelope.ok ? {} : { errorCategory: envelope.error.category, errorCode: envelope.error.code }),
    ...(items == null ? {} : { itemFailures: items.failed, itemTotal: items.total }),
    ...(cacheHit == null ? {} : { cacheHit }),
    ...(savedMs == null ? {} : { savedMs }),
    ...(shaped == null ? {} : { shaped }),
    resultBytes, resultTokens, truncated, durationMs,
  };
}

/** Collects a run's tool steps as plain data while the loop runs; it never does I/O. */
export function createTraceRecorder(params: CreateTraceRecorderParams): TraceRecorder {
  const { now, captureContent, argsDigestKey, nonOutcomeTools = [] } = params;
  const recorded: TraceStep[] = [];
  const finished = new Set<number>();
  const skipped = new Set(nonOutcomeTools);

  /** Inner aigent_multi calls are part of their parent step, which is what the model reports on. */
  function findTarget(turn: number): TraceStep | undefined {
    // Walks back from the newest step, so the most recently started eligible step of an earlier turn wins.
    for (let stepIndex = recorded.length - 1; stepIndex >= 0; stepIndex -= 1) {
      const step = recorded[stepIndex] as TraceStep;
      if (step.turn < turn && step.parentCallId == null && !skipped.has(step.tool)) return step;
    }
    return undefined;
  }

  function attachOutcome(outcomeParams: AttachOutcomeParams): void {
    const { outcome: { success, answer }, source, turn } = outcomeParams;
    const target = findTarget(turn);
    if (target == null) return;
    // Only a directive may replace an existing outcome, and only one that came from previous.
    if (target.outcome != null && !(source === 'directive' && target.outcome.source === 'previous')) return;
    target.outcome = { success, answer: captureContent ? answer : '', source };
  }

  function outcomeTarget(turn: number): OutcomeTarget | undefined {
    const target = findTarget(turn);
    return target == null ? undefined : { index: target.index, turn: target.turn, hasOutcome: target.outcome != null };
  }

  function begin(stepParams: BeginStepParams): FinishStep {
    const { turn, callId, parentCallId, tool, args } = stepParams;
    const index = recorded.length;
    recorded.push({
      index, turn, callId, ...(parentCallId == null ? {} : { parentCallId }), tool,
      argsSummary: summariseArgs({ args, captureContent }),
      argsHash: digestArgs({ args, key: argsDigestKey }),
      ...(captureContent ? { args: structuredClone(args) } : {}),
      ok: false, resultBytes: 0, resultTokens: 0, truncated: false, durationMs: 0, startedAtMs: now(),
    });
    return executed => {
      if (finished.has(index)) return;
      finished.add(index);
      const { guardrails: decisions = [] } = executed;
      Object.assign(recorded[index] as TraceStep, finishedFields(executed), decisions.length === 0 ? {} : { guardrails: storedDecisions({ decisions, captureContent }) });
    };
  }

  function steps(): TraceStep[] {
    return recorded.map(step => (finished.has(step.index)
      ? structuredClone(step)
      : { ...structuredClone(step), ok: false, errorCategory: 'aborted', errorCode: UNFINISHED_ERROR_CODE, durationMs: now() - step.startedAtMs }));
  }

  return { begin, attachOutcome, outcomeTarget, steps };
}
