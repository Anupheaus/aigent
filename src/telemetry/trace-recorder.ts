import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { OutcomeSource, StepOutcome, TraceStep } from './run-record.js';
import { summariseArgs } from './summarise-args.js';

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
  /** The reporting call's own step index; absent for a directive, which reports on every step started so far. */
  beforeIndex?: number;
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
   * Attaches the agent's verdict to the last top-level step started before the report. A step keeps one outcome: a
   * directive replaces a `previous` report, but never the other way round.
   */
  attachOutcome(params: AttachOutcomeParams): void;
  /** The step a report made before `beforeIndex` (default: now) would attach to, if any. */
  outcomeTarget(beforeIndex?: number): OutcomeTarget | undefined;
  /** Every step so far in start order; a step still running is reported as aborted. */
  steps(): TraceStep[];
}

export interface CreateTraceRecorderParams {
  now(): number;
  /** Whether argument values (`args`, a value-bearing `argsSummary`) and outcome answers are kept. */
  captureContent: boolean;
  /** Tools whose steps never receive outcomes (commentary such as `aigent_feedback`, not work). */
  nonOutcomeTools?: string[];
}

/** Marks a step that never finished, e.g. an inner call cut off when its `aigent_multi` call timed out. */
const UNFINISHED_ERROR_CODE = 'step_unfinished';

function finishedFields(executed: ExecutedToolCall): Partial<TraceStep> {
  const { envelope, durationMs, size: { resultBytes, resultTokens, truncated }, items } = executed;
  return {
    ok: envelope.ok,
    ...(envelope.ok ? {} : { errorCategory: envelope.error.category, errorCode: envelope.error.code }),
    ...(items == null ? {} : { itemFailures: items.failed, itemTotal: items.total }),
    resultBytes, resultTokens, truncated, durationMs,
  };
}

/** Collects a run's tool steps as plain data while the loop runs; it never does I/O. */
export function createTraceRecorder(params: CreateTraceRecorderParams): TraceRecorder {
  const { now, captureContent, nonOutcomeTools = [] } = params;
  const recorded: TraceStep[] = [];
  const finished = new Set<number>();
  const skipped = new Set(nonOutcomeTools);

  /** Inner aigent_multi calls are part of their parent step, which is what the model reports on. */
  function findTarget(beforeIndex: number): TraceStep | undefined {
    // Walks back from the report, so the most recently started eligible step wins.
    for (let stepIndex = Math.min(beforeIndex, recorded.length) - 1; stepIndex >= 0; stepIndex -= 1) {
      const step = recorded[stepIndex] as TraceStep;
      if (step.parentCallId == null && !skipped.has(step.tool)) return step;
    }
    return undefined;
  }

  function attachOutcome(outcomeParams: AttachOutcomeParams): void {
    const { outcome: { success, answer }, source, beforeIndex = recorded.length } = outcomeParams;
    const target = findTarget(beforeIndex);
    if (target == null) return;
    if (target.outcome?.source === 'directive' && source === 'previous') return;
    target.outcome = { success, answer: captureContent ? answer : '', source };
  }

  function outcomeTarget(beforeIndex = recorded.length): OutcomeTarget | undefined {
    const target = findTarget(beforeIndex);
    return target == null ? undefined : { index: target.index, turn: target.turn, hasOutcome: target.outcome != null };
  }

  function begin(stepParams: BeginStepParams): FinishStep {
    const { turn, callId, parentCallId, tool, args } = stepParams;
    const index = recorded.length;
    recorded.push({
      index, turn, callId, ...(parentCallId == null ? {} : { parentCallId }), tool,
      argsSummary: summariseArgs({ args, captureContent }),
      ...(captureContent ? { args: structuredClone(args) } : {}),
      ok: false, resultBytes: 0, resultTokens: 0, truncated: false, durationMs: 0, startedAtMs: now(),
    });
    return executed => {
      if (finished.has(index)) return;
      finished.add(index);
      Object.assign(recorded[index] as TraceStep, finishedFields(executed));
    };
  }

  function steps(): TraceStep[] {
    return recorded.map(step => (finished.has(step.index)
      ? structuredClone(step)
      : { ...structuredClone(step), ok: false, errorCategory: 'aborted', errorCode: UNFINISHED_ERROR_CODE, durationMs: now() - step.startedAtMs }));
  }

  return { begin, attachOutcome, outcomeTarget, steps };
}
