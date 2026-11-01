import { describe, expect, it } from 'vitest';
import type { RunSuccess } from '../learning/run-success.js';
import { toBanditArm } from './routing-stats.js';

const RATED_CORRECT: RunSuccess = { value: 1, weight: 2, isUserVerdict: true };
const CLAIMED_FAILURE: RunSuccess = { value: 0, weight: 1, isUserVerdict: false };

describe('toBanditArm', () => {
  it('gives the weighted rate over the run count, so verdicts never shrink the exploration bonus', () => {
    const arm = toBanditArm({ model: 'p:small', outcomes: [RATED_CORRECT, RATED_CORRECT, CLAIMED_FAILURE], costsUsd: [] });
    // Weighted: 4 of 5. Three runs, not five trials.
    expect(arm.trials).toBe(3);
    expect(arm.successes / arm.trials).toBeCloseTo(0.8, 9);
  });
});
