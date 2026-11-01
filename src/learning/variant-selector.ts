import { createHash } from 'node:crypto';
import type { StrategyVariant } from './strategy-types.js';

/** Hex digits of the hash read as the assignment fraction (32 bits). */
const SCORE_HEX_DIGITS = 8;
const SCORE_RANGE = 0x1_0000_0000;

/** A run's place in [0, 1), from its key and the seed alone: the same run always gets the same arm. */
export function assignmentScore(params: { runKey: string; seed: number }): number {
  const { runKey, seed } = params;
  const digest = createHash('sha256').update(`${seed}:${runKey}`).digest('hex');
  return Number.parseInt(digest.slice(0, SCORE_HEX_DIGITS), 16) / SCORE_RANGE;
}

/** The variants one run uses. */
export interface RunVariants {
  arm: 'trial' | 'control';
  /** The agent's variant in trial, whichever arm the run got. */
  trial?: StrategyVariant;
  /** Active variants, sorted by id. */
  active: StrategyVariant[];
  /** What the run applies: the active variants, plus the trial one on the trial arm. Sorted by id. */
  applied: StrategyVariant[];
}

function byId(left: StrategyVariant, right: StrategyVariant): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Which variants a run of the agent uses: every active variant, and the oldest variant in trial for the share of runs
 * whose assignment score is below `trialShare`.
 */
export function selectVariants(params: { variants: StrategyVariant[]; agentName: string; runKey: string; seed: number; trialShare: number }): RunVariants {
  const { variants, agentName, runKey, seed, trialShare } = params;
  const own = variants.filter(variant => variant.agentName === agentName);
  const active = own.filter(({ status }) => status === 'active').sort(byId);
  const [trial] = own.filter(({ status }) => status === 'trial').sort((left, right) => (left.trialStartedAt ?? 0) - (right.trialStartedAt ?? 0) || byId(left, right));
  const isTrial = trial != null && assignmentScore({ runKey, seed }) < trialShare;
  return {
    arm: isTrial ? 'trial' : 'control', active, applied: isTrial ? [...active, trial].sort(byId) : active,
    ...(trial == null ? {} : { trial }),
  };
}
