import { splitPrevious } from '../feedback/previous-outcome.js';
import type { ToolCall } from '../providers/provider-types.js';
import type { TraceRecorder } from '../telemetry/trace-recorder.js';
import type { AigentEvent } from './aigent-events.js';

/** A run's feedback switch and the little state the `previous` field needs. */
export interface RunFeedback {
  /** Calls carry `previous`: it is stripped from their arguments and linked to the step before them. */
  isEnabled: boolean;
  /** Set once the run has warned about a missing `previous`, so it warns only once. */
  hasWarnedMissing: boolean;
}

export interface LinkPreviousParams {
  call: ToolCall;
  /** The model request this call belongs to. */
  turn: number;
  recorder: TraceRecorder;
  feedback: RunFeedback;
  emit(event: AigentEvent): void;
}

/**
 * Takes `previous` out of a call's arguments before anything else sees them and records it against the step started
 * before this call. A missing `previous` is a soft omission: the call still runs, and the run warns once when a step
 * from an earlier turn is left without an outcome. Returns the arguments without `previous`.
 */
export function linkPrevious(params: LinkPreviousParams): unknown {
  const { call: { id: callId, name, args: rawArgs }, turn, recorder, feedback, emit } = params;
  const { args, previous } = splitPrevious(rawArgs);
  if (previous.kind === 'reported') {
    recorder.attachOutcome({ outcome: previous.outcome, source: 'previous' });
    return args;
  }
  if (previous.kind === 'invalid') {
    emit({ type: 'warning', message: `Ignored invalid previous on call '${callId}' to '${name}': ${previous.reason}` });
    return args;
  }
  const target = recorder.outcomeTarget();
  // Calls in the run's first tool turn have nothing to report, and a directive may already have covered the step.
  const isExpected = target != null && target.turn < turn && !target.hasOutcome;
  if (isExpected && !feedback.hasWarnedMissing) {
    feedback.hasWarnedMissing = true;
    emit({ type: 'warning', message: `"previous" was missing on tool call '${callId}' to '${name}'; report how the previous tool step went on every call after the first (warned once per run)` });
  }
  return args;
}
