import { compareRunOrder } from '../scoring/baseline.js';
import type { RequestAnalysis } from '../scoring/report-types.js';
import { weightedTokens } from '../scoring/run-metrics.js';
import { median } from '../scoring/stats.js';
import { topLevelWorkSteps } from '../scoring/work-steps.js';
import type { RunTrace, StepOutcome } from '../telemetry/run-record.js';
import type { TaskGroup } from './trace-group.js';
import { wastedStepsOf } from './wasted-steps.js';

/** The last outcome the agent reported in the run, if any. */
function lastOutcome(trace: RunTrace): StepOutcome | undefined {
  return trace.steps.map(({ outcome }) => outcome).filter((outcome): outcome is StepOutcome => outcome != null).at(-1);
}

/**
 * The user's verdict is ground truth: `incorrect` never counts and `correct` always does. Otherwise the agent must have
 * claimed success on its last reported outcome.
 */
export function isSuccessfulRun(trace: RunTrace): boolean {
  const { run: { userVerdict } } = trace;
  if (userVerdict === 'incorrect') return false;
  if (userVerdict === 'correct') return true;
  return lastOutcome(trace)?.success === true;
}

/** Fewest tokens, then turns, then time; start order breaks the remaining ties. */
function compareCost(left: RunTrace, right: RunTrace): number {
  const byTokens = weightedTokens(left.run) - weightedTokens(right.run);
  if (byTokens !== 0) return byTokens;
  const byTurns = left.run.usage.turns - right.run.usage.turns;
  if (byTurns !== 0) return byTurns;
  const byDuration = left.run.timings.durationMs - right.run.timings.durationMs;
  return byDuration !== 0 ? byDuration : compareRunOrder(left.run, right.run);
}

function nonNegative(value: number): number {
  return Math.max(0, value);
}

/**
 * How a group of similar requests was solved: its typical cost, the cheapest successful path (never one the user
 * rated incorrect), the steps a better path would not have needed, and what matching the cheapest path would save.
 */
export function analyseRequest(group: TaskGroup): RequestAnalysis {
  const { groupId, sampleTask } = group;
  const traces = [...group.traces].sort((left, right) => compareRunOrder(left.run, right.run));
  const successful = traces.filter(isSuccessfulRun);
  const [cheapest] = [...successful].sort(compareCost);
  const typical = {
    medianTokens: median(traces.map(({ run }) => weightedTokens(run))) ?? 0,
    medianTurns: median(traces.map(({ run }) => run.usage.turns)) ?? 0,
    medianToolCalls: median(traces.map(({ run }) => run.usage.toolCalls)) ?? 0,
  };
  const analysis: RequestAnalysis = {
    groupId, sampleTask, runs: traces.length, successfulRuns: successful.length, typical,
    wastedSteps: traces.flatMap(wastedStepsOf),
    potentialSaving: { tokens: 0, turns: 0 },
  };
  if (cheapest == null) return analysis;
  const { run, steps } = cheapest;
  const tokens = weightedTokens(run);
  const { turns, toolCalls } = run.usage;
  return {
    ...analysis,
    cheapestSuccessful: { runId: run.runId, tokens, turns, toolCalls, durationMs: run.timings.durationMs, path: topLevelWorkSteps(steps).map(({ tool }) => tool) },
    potentialSaving: { tokens: nonNegative(typical.medianTokens - tokens), turns: nonNegative(typical.medianTurns - turns) },
  };
}
