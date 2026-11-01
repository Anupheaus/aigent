import { describe, expect, it } from 'vitest';
import { assignmentScore, selectVariants } from './variant-selector.js';
import { variantFixture } from './strategy.test-support.js';

describe('selectVariants', () => {
  const trial = variantFixture({ id: 'v_trial', status: 'trial' });
  const active = [variantFixture({ id: 'v_b', status: 'active' }), variantFixture({ id: 'v_a', status: 'active' })];
  const others = [variantFixture({ id: 'v_c', status: 'candidate' }), variantFixture({ id: 'v_other', agentName: 'other', status: 'active' })];
  const variants = [trial, ...active, ...others];

  it('assigns the same run the same arm every time, and other seeds differently', () => {
    const arms = (seed: number): string[] => Array.from({ length: 50 }, (_, index) => selectVariants({ variants, agentName: 'helper', runKey: `run_${index}`, seed, trialShare: 0.5 }).arm);
    expect(arms(1)).toEqual(arms(1));
    expect(arms(1)).not.toEqual(arms(2));
  });

  it('gives the trial to about trialShare of the runs', () => {
    const trialRuns = Array.from({ length: 4_000 }, (_, index) => assignmentScore({ runKey: `run_${index}`, seed: 0 })).filter(score => score < 0.2).length;
    // Binomial(4000, 0.2): mean 800, sd 25.3.
    expect(trialRuns).toBeGreaterThan(700);
    expect(trialRuns).toBeLessThan(900);
  });

  it('applies the agent\'s active variants to every run, sorted, and the trial one on the trial arm only', () => {
    const selections = Array.from({ length: 40 }, (_, index) => selectVariants({ variants, agentName: 'helper', runKey: `run_${index}`, seed: 0, trialShare: 0.5 }));
    const control = selections.find(({ arm }) => arm === 'control')!;
    const trialArm = selections.find(({ arm }) => arm === 'trial')!;
    expect(control.applied.map(({ id }) => id)).toEqual(['v_a', 'v_b']);
    expect(trialArm.applied.map(({ id }) => id)).toEqual(['v_a', 'v_b', 'v_trial']);
    expect(control.trial?.id).toBe('v_trial');
  });

  it('applies nothing to an agent without variants', () => {
    expect(selectVariants({ variants, agentName: 'nobody', runKey: 'r', seed: 0, trialShare: 1 })).toEqual({ arm: 'control', active: [], applied: [] });
  });
});
