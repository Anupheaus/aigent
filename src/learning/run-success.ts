import type { RunRecord } from '../telemetry/run-record.js';

/** A user's verdict counts this many times an agent's own claim: the user is the ground truth. */
export const USER_VERDICT_WEIGHT = 2;
export const AGENT_CLAIM_WEIGHT = 1;
const PARTIAL_VALUE = 0.5;

/** One run's outcome for learning statistics: a value in [0, 1] and how much it weighs. */
export interface RunSuccess {
  value: number;
  weight: number;
  /** The value came from a user's rating. */
  isUserVerdict: boolean;
}

/**
 * How well a run went: the user's verdict when there is one (correct 1, partial 0.5, incorrect 0, at double weight),
 * else the agent's own outcome (completed without more failure claims than success claims). Dry runs changed nothing
 * and tell nothing about the answer, so they are left out (undefined).
 */
export function runSuccess(run: RunRecord): RunSuccess | undefined {
  const { userVerdict, status, outcomeSummary: { claimedSuccess, claimedFailure }, dryRun } = run;
  if (dryRun === true) return undefined;
  if (userVerdict != null) {
    const value = userVerdict === 'correct' ? 1 : userVerdict === 'partial' ? PARTIAL_VALUE : 0;
    return { value, weight: USER_VERDICT_WEIGHT, isUserVerdict: true };
  }
  const isSuccess = status === 'completed' && claimedSuccess >= claimedFailure;
  return { value: isSuccess ? 1 : 0, weight: AGENT_CLAIM_WEIGHT, isUserVerdict: false };
}

/** Weighted success rate of runs (0 for none) and the weighted successes and trials behind it. */
export function weightedRate(outcomes: RunSuccess[]): { rate: number; successes: number; trials: number } {
  const trials = outcomes.reduce((total, { weight }) => total + weight, 0);
  const successes = outcomes.reduce((total, { value, weight }) => total + value * weight, 0);
  return { rate: trials === 0 ? 0 : successes / trials, successes, trials };
}
