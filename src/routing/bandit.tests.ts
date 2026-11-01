import { describe, expect, it } from 'vitest';
import { createSeededRandom } from '../core/runtime-services.js';
import { chooseArm } from './bandit.js';
import type { BanditArm } from './bandit.js';

interface SimulatedArm {
  model: string;
  probability: number;
  costUsd: number;
}

/** Plays `pulls` rounds of UCB1 against Bernoulli arms with a seeded source; returns the regret and the choices. */
function simulate(params: { arms: SimulatedArm[]; pulls: number; seed: number; costWeight?: number }): { regret: number; choices: string[] } {
  const { arms, pulls, seed, costWeight = 0 } = params;
  const random = createSeededRandom(seed);
  const stats = new Map<string, BanditArm>(arms.map(({ model }) => [model, { model, successes: 0, trials: 0, meanCostUsd: 0 }]));
  // Each arm is pulled once first, as UCB1 requires.
  const best = Math.max(...arms.map(({ probability }) => probability));
  let regret = 0;
  const choices: string[] = [];
  for (let pull = 0; pull < pulls; pull += 1) {
    const unpulled = [...stats.values()].find(({ trials }) => trials === 0);
    const model = unpulled?.model ?? chooseArm({ arms: [...stats.values()], costWeight });
    const arm = arms.find(candidate => candidate.model === model)!;
    const current = stats.get(model)!;
    stats.set(model, { model, successes: current.successes + (random() < arm.probability ? 1 : 0), trials: current.trials + 1, meanCostUsd: arm.costUsd });
    regret += best - arm.probability;
    choices.push(model);
  }
  return { regret, choices };
}

/** Auer et al. (2002), theorem 1: UCB1's expected regret is at most sum over worse arms of 8 ln n / gap + (1 + pi^2 / 3) gap. */
function ucb1RegretBound(params: { probabilities: number[]; pulls: number }): number {
  const { probabilities, pulls } = params;
  const best = Math.max(...probabilities);
  return probabilities.filter(probability => probability < best).reduce((total, probability) => {
    const gap = best - probability;
    return total + 8 * Math.log(pulls) / gap + (1 + Math.PI ** 2 / 3) * gap;
  }, 0);
}

describe('chooseArm (UCB1)', () => {
  const arms: SimulatedArm[] = [{ model: 'a', probability: 0.5, costUsd: 0 }, { model: 'b', probability: 0.7, costUsd: 0 }, { model: 'c', probability: 0.9, costUsd: 0 }];
  const pulls = 2_000;

  it.each([1, 2, 3, 4, 5])('stays within the UCB1 regret bound and settles on the best arm (seed %i)', seed => {
    const { regret, choices } = simulate({ arms, pulls, seed });
    expect(regret).toBeLessThan(ucb1RegretBound({ probabilities: arms.map(({ probability }) => probability), pulls }));
    const lastChoices = choices.slice(-500);
    expect(lastChoices.filter(model => model === 'c').length / lastChoices.length).toBeGreaterThan(0.8);
  });

  it('trades success for cost by costWeight', () => {
    // Equal success, one ten times dearer: with a cost weight the cheap one wins; without, it is a coin toss of the index.
    const priced: BanditArm[] = [{ model: 'cheap', successes: 90, trials: 100, meanCostUsd: 0.001 }, { model: 'dear', successes: 91, trials: 100, meanCostUsd: 0.01 }];
    expect(chooseArm({ arms: priced, costWeight: 0.2 })).toBe('cheap');
    expect(chooseArm({ arms: priced, costWeight: 0 })).toBe('dear');
  });

  it('breaks ties by model name, so the choice is deterministic', () => {
    expect(chooseArm({ arms: [{ model: 'z', successes: 5, trials: 10, meanCostUsd: 0 }, { model: 'm', successes: 5, trials: 10, meanCostUsd: 0 }], costWeight: 0 })).toBe('m');
  });
});
