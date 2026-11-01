import { describe, expect, it } from 'vitest';
import { fixtureRun } from '../scoring/fixtures.test-support.js';
import { runSuccess, weightedRate } from './run-success.js';

describe('runSuccess', () => {
  it('lets the user verdict outrank the agent claims', () => {
    // The agent claimed success on a completed run, but the user said incorrect: the user wins.
    const claimed = fixtureRun({ startedAt: 1, runId: 'r1', claimedSuccess: 3, userVerdict: 'incorrect' });
    expect(runSuccess(claimed)).toEqual({ value: 0, weight: 2, isUserVerdict: true });
    expect(runSuccess(fixtureRun({ startedAt: 1, runId: 'r2', status: 'failed', userVerdict: 'correct' }))).toEqual({ value: 1, weight: 2, isUserVerdict: true });
    expect(runSuccess(fixtureRun({ startedAt: 1, runId: 'r3', userVerdict: 'partial' }))?.value).toBe(0.5);
  });

  it('uses the agent outcome and status without a verdict, at the lower weight', () => {
    expect(runSuccess(fixtureRun({ startedAt: 1, runId: 'r1', claimedSuccess: 1 }))).toEqual({ value: 1, weight: 1, isUserVerdict: false });
    expect(runSuccess(fixtureRun({ startedAt: 1, runId: 'r2', claimedSuccess: 1, claimedFailure: 2 }))?.value).toBe(0);
    expect(runSuccess(fixtureRun({ startedAt: 1, runId: 'r3', status: 'limit_reached' }))?.value).toBe(0);
  });

  it('leaves dry runs out', () => {
    expect(runSuccess({ ...fixtureRun({ startedAt: 1, runId: 'r1' }), dryRun: true })).toBeUndefined();
  });

  it('weights the rate', () => {
    // One user-correct (2 of 2) and one agent failure (0 of 1): 2 / 3.
    expect(weightedRate([{ value: 1, weight: 2, isUserVerdict: true }, { value: 0, weight: 1, isUserVerdict: false }]).rate).toBeCloseTo(2 / 3);
    expect(weightedRate([]).rate).toBe(0);
  });
});
