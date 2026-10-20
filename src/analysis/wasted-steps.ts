import type { WastedStepReason } from '../scoring/report-types.js';
import { isWorkStep } from '../scoring/work-steps.js';
import type { RunTrace, TraceStep } from '../telemetry/run-record.js';

export interface WastedStep {
  runId: string;
  stepIndex: number;
  reason: WastedStepReason;
}

/** Tool names that look up candidates rather than act, so a later call to the same tool supersedes an earlier one. */
const SEARCH_LIKE = /search|find|list|grep|glob|query|lookup/;

/** The argument keys of a call, from its captured arguments or, failing that, its summary. */
function argumentKeys(step: TraceStep): string {
  const { args, argsSummary } = step;
  if (typeof args === 'object' && args !== null) return Object.keys(args).sort().join(',');
  try {
    const parsed: unknown = JSON.parse(argsSummary);
    return typeof parsed === 'object' && parsed !== null ? Object.keys(parsed).sort().join(',') : argsSummary;
  } catch { // a summary cut at 120 characters is not valid JSON; its text is the best key left
    return argsSummary;
  }
}

/** Why one step was not needed, if it was not; the first matching reason wins. */
function wasteOf(params: { step: TraceStep; earlier: TraceStep[]; later: TraceStep[] }): WastedStepReason | undefined {
  const { step, earlier, later } = params;
  const sameTool = (other: TraceStep): boolean => other.tool === step.tool;
  if (!step.ok && later.some(other => sameTool(other) && other.ok)) return 'failed-before-success';
  if (earlier.some(other => sameTool(other) && other.ok && other.argsSummary === step.argsSummary)) return 'repeat-call';
  if (SEARCH_LIKE.test(step.tool) && later.some(other => sameTool(other) && other.argsSummary !== step.argsSummary)) return 'superseded-search';
  // Back-to-back calls to one tool with the same argument keys, a turn apart and nothing in between, could have been
  // one batch. Inner aigent_multi calls were already batched by the model, and a refined search depends on the results
  // of the one before it (that one is reported as superseded instead).
  if (step.parentCallId != null || SEARCH_LIKE.test(step.tool)) return undefined;
  const previous = earlier.filter(other => other.parentCallId == null).at(-1);
  if (previous != null && sameTool(previous) && previous.turn !== step.turn && argumentKeys(previous) === argumentKeys(step)) return 'unbatched';
  return undefined;
}

/** Steps of one run that a better path would not have needed, in step order. */
export function wastedStepsOf(trace: RunTrace): WastedStep[] {
  const { run: { runId }, steps } = trace;
  const work = steps.filter(isWorkStep);
  return work.flatMap((step, position) => {
    const reason = wasteOf({ step, earlier: work.slice(0, position), later: work.slice(position + 1) });
    return reason == null ? [] : [{ runId, stepIndex: step.index, reason }];
  });
}
