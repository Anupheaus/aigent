import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { TraceStep } from './run-record.js';
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

export interface TraceRecorder {
  /** Starts a step (its index is its start order) and returns the function that finishes it. */
  begin(params: BeginStepParams): FinishStep;
  /** Every step so far in start order; a step still running is reported as aborted. */
  steps(): TraceStep[];
}

export interface CreateTraceRecorderParams {
  now(): number;
  /** Whether argument values are kept (`args`, a value-bearing `argsSummary`). */
  captureContent: boolean;
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
  const { now, captureContent } = params;
  const recorded: TraceStep[] = [];
  const finished = new Set<number>();

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

  return { begin, steps };
}
