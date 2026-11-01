import { runSuccess, weightedRate } from '../learning/run-success.js';
import type { RunSuccess } from '../learning/run-success.js';
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

export function toBanditArm(arm: ArmRecord): BanditArm {
  const { successes, trials } = weightedRate(arm.outcomes);
  return { model: arm.model, successes, trials, meanCostUsd: meanCost(arm.costsUsd) };
}

export interface DegradationParams {
  outcomes: RunSuccess[];
  /** Recent runs compared. */
  window: number;
  /** Earlier runs needed before a comparison counts. */
  minSamples: number;
  revertDrop: number;
}

/**
 * The earlier and recent rates when the last `window` runs fell more than `revertDrop` below the runs before them;
 * undefined otherwise (also when there are not yet `minSamples` earlier runs and a full window).
 */
export function degradation(params: DegradationParams): { earlierRate: number; recentRate: number } | undefined {
  const { outcomes, window, minSamples, revertDrop } = params;
  const earlier = outcomes.slice(0, -window);
  if (earlier.length < minSamples || outcomes.length - earlier.length < window) return undefined;
  const earlierRate = weightedRate(earlier).rate;
  const recentRate = weightedRate(outcomes.slice(-window)).rate;
  return earlierRate - recentRate > revertDrop ? { earlierRate, recentRate } : undefined;
}
