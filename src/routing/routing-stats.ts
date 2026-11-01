import { runSuccess, weightedRate } from '../learning/run-success.js';
import type { RunSuccess } from '../learning/run-success.js';
import { oneSidedProportionPValue } from '../scoring/stats.js';
import type { RunRecord } from '../telemetry/run-record.js';
import type { BanditArm } from './bandit.js';
import type { RouteAlternative } from './routing-types.js';

/** One model's runs in a bucket, oldest first. */
export interface ArmRecord {
  model: string;
  outcomes: RunSuccess[];
  /** Costs of its priced runs. */
  costsUsd: number[];
}

export interface RouteArmsParams {
  runs: RunRecord[];
  agentName: string;
  bucket: string;
  /** The routed models, in any order; each gets an arm, runs or not. */
  models: string[];
  /** A run's cost, undefined when its model has no price. */
  price?(run: RunRecord): number | undefined;
}

/** Each routed model's runs of the agent in the bucket (only runs that were routed record a bucket). */
export function routeArms(params: RouteArmsParams): ArmRecord[] {
  const { runs, agentName, bucket, models, price } = params;
  const inBucket = runs
    .filter(run => run.agentName === agentName && run.route?.evidence?.bucket === bucket)
    .sort((left, right) => left.recordedAt - right.recordedAt || (left.runId < right.runId ? -1 : 1));
  return [...new Set(models)].sort().map(model => {
    const own = inBucket.filter(run => run.model === model);
    const outcomes = own.flatMap(run => { const success = runSuccess(run); return success == null ? [] : [success]; });
    const costsUsd = own.flatMap(run => { const cost = price?.(run); return cost == null ? [] : [cost]; });
    return { model, outcomes, costsUsd };
  });
}

function meanCost(costsUsd: number[]): number {
  return costsUsd.length === 0 ? 0 : costsUsd.reduce((total, cost) => total + cost, 0) / costsUsd.length;
}

export function toAlternative(arm: ArmRecord): RouteAlternative {
  const { model, outcomes, costsUsd } = arm;
  return { model, successRate: weightedRate(outcomes).rate, meanCostUsd: meanCost(costsUsd), n: outcomes.length };
}

/**
 * The arm as the bandit and the confidence bounds see it: the weighted rate (user verdicts outweigh agent claims) over
 * the run count. A verdict makes a run count for more in the rate, never makes it two samples.
 */
export function toBanditArm(arm: ArmRecord): BanditArm {
  const { model, outcomes, costsUsd } = arm;
  const { rate } = weightedRate(outcomes);
  return { model, successes: rate * outcomes.length, trials: outcomes.length, meanCostUsd: meanCost(costsUsd) };
}

export interface DegradationParams {
  outcomes: RunSuccess[];
  /** Recent runs compared. */
  window: number;
  /** Earlier runs needed before a comparison counts. */
  minSamples: number;
  revertDrop: number;
  /**
   * Outcomes the arm had when it was last reverted: the recent window must lie wholly after them, so a revert is
   * only ever decided on runs it has not been judged on before. 0 (default) when it was never reverted.
   */
  judgedOutcomes?: number;
}

/**
 * The one-sided level a drop must reach before it reverts. The check runs at every choice over overlapping windows,
 * so it is held well below the usual 0.05: a stable model must not be thrown out by an unlucky stretch.
 */
export const REVERT_ALPHA = 0.005;

/**
 * The earlier and recent rates when the last `window` runs fell more than `revertDrop` below the runs before them and
 * the drop is significant (one-sided two-proportion test at `REVERT_ALPHA`, on run counts); undefined otherwise (also
 * when there are not yet `minSamples` earlier runs and a full window of runs after `judgedOutcomes`).
 */
export function degradation(params: DegradationParams): { earlierRate: number; recentRate: number } | undefined {
  const { outcomes, window, minSamples, revertDrop, judgedOutcomes = 0 } = params;
  const earlier = outcomes.slice(0, -window);
  if (earlier.length < minSamples || outcomes.length - earlier.length < window || earlier.length < judgedOutcomes) return undefined;
  const recent = outcomes.slice(-window);
  const earlierRate = weightedRate(earlier).rate;
  const recentRate = weightedRate(recent).rate;
  if (earlierRate - recentRate <= revertDrop) return undefined;
  const pValue = oneSidedProportionPValue({
    treatment: { successes: earlierRate * earlier.length, n: earlier.length },
    control: { successes: recentRate * recent.length, n: recent.length },
  });
  return pValue < REVERT_ALPHA ? { earlierRate, recentRate } : undefined;
}
