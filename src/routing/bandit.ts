import { createAigentError } from '../core/aigent-error.js';

/** One model's weighted record, as the bandit sees it. */
export interface BanditArm {
  model: string;
  /** Weighted successes (see `runSuccess`). */
  successes: number;
  /** Weighted trials; must be above 0 for every arm passed to `chooseArm`. */
  trials: number;
  meanCostUsd: number;
}

/** UCB1's exploration constant: the bonus is sqrt(2 ln N / n). */
const UCB_EXPLORATION = 2;

function compareModel(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * UCB1 over success rate minus a cost penalty: each arm scores `rate - costWeight * cost / dearest cost + sqrt(2 ln N
 * / n)`, so a model is chosen for being good, cheap or under-tried. Ties go to the first model by name.
 */
export function chooseArm(params: { arms: BanditArm[]; costWeight: number }): string {
  const { arms, costWeight } = params;
  const totalTrials = arms.reduce((total, { trials }) => total + trials, 0);
  const dearest = Math.max(0, ...arms.map(({ meanCostUsd }) => meanCostUsd));
  const scored = arms.map(arm => {
    const { model, successes, trials, meanCostUsd } = arm;
    const costPenalty = dearest === 0 ? 0 : costWeight * meanCostUsd / dearest;
    const bonus = Math.sqrt(UCB_EXPLORATION * Math.log(totalTrials) / trials);
    return { model, score: successes / trials - costPenalty + bonus };
  });
  const [best] = scored.sort((left, right) => right.score - left.score || compareModel(left.model, right.model));
  if (best == null) throw createAigentError({ code: 'invalid_input', message: 'chooseArm needs at least one arm, got none' });
  return best.model;
}
