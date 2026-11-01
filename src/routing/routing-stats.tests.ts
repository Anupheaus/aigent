import { describe, expect, it } from 'vitest';
import type { RunSuccess } from '../learning/run-success.js';
import { fixtureRun } from '../scoring/fixtures.test-support.js';
import type { RunRecord } from '../telemetry/run-record.js';
import { routeArms, toBanditArm } from './routing-stats.js';

const RATED_CORRECT: RunSuccess = { value: 1, weight: 2, isUserVerdict: true };
const CLAIMED_FAILURE: RunSuccess = { value: 0, weight: 1, isUserVerdict: false };

const BUCKET = 'short:search';

function routedRun(params: { runId: string; model: string; rescuedBy?: string; userVerdict?: 'correct' }): RunRecord {
  const { runId, model, rescuedBy, userVerdict } = params;
  const run = fixtureRun({ startedAt: Number(runId.replace(/\D/g, '')), runId, model, claimedSuccess: 1, ...(userVerdict == null ? {} : { userVerdict }) });
  return {
    ...run, route: { model, reason: 'learned', evidence: { bucket: BUCKET, minSamples: 20 }, alternatives: [] },
    ...(rescuedBy == null ? {} : { fallbacks: [{ model: rescuedBy, settings: {} }] }),
  };
}

describe('routeArms', () => {
  it('counts a run a fallback rescued as a failure of the chosen model, never as its success or cost', () => {
    const runs = [
      routedRun({ runId: 'run_1', model: 'cheap:m' }),
      routedRun({ runId: 'run_2', model: 'cheap:m', rescuedBy: 'dear:m' }),
      routedRun({ runId: 'run_3', model: 'cheap:m', rescuedBy: 'dear:m', userVerdict: 'correct' }),
    ];
    const arms = routeArms({ runs, agentName: 'helper', bucket: BUCKET, models: ['cheap:m', 'dear:m'], price: () => 0.01 });
    const cheap = arms.find(({ model }) => model === 'cheap:m');
    expect(cheap?.outcomes.map(({ value }) => value)).toEqual([1, 0, 0]);
    // The rescued runs' usage was partly the fallback's, so it is not the chosen model's cost.
    expect(cheap?.costsUsd).toEqual([0.01]);
    // The fallback was not the routed choice: its arm learns nothing from them.
    expect(arms.find(({ model }) => model === 'dear:m')?.outcomes).toEqual([]);
  });
});

describe('toBanditArm', () => {
  it('gives the weighted rate over the run count, so verdicts never shrink the exploration bonus', () => {
    const arm = toBanditArm({ model: 'p:small', outcomes: [RATED_CORRECT, RATED_CORRECT, CLAIMED_FAILURE], costsUsd: [] });
    // Weighted: 4 of 5. Three runs, not five trials.
    expect(arm.trials).toBe(3);
    expect(arm.successes / arm.trials).toBeCloseTo(0.8, 9);
  });
});
