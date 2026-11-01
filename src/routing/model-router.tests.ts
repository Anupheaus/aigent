import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createSeededRandom } from '../core/runtime-services.js';
import { fixtureRun } from '../scoring/fixtures.test-support.js';
import type { RunRecord } from '../telemetry/run-record.js';
import { createModelRouter } from './model-router.js';
import type { ModelRoutes, RoutingOptions, TaskFeatures } from './routing-types.js';
import { extractTaskFeatures, featureBucket } from './task-features.js';

const ROUTES: ModelRoutes = { default: 'p:big', cheap: 'p:small', capable: 'p:huge' };
const FEATURES: TaskFeatures = extractTaskFeatures({ task: 'find the readme' });
const BUCKET = featureBucket(FEATURES);

interface RunsBuilder {
  runs: RunRecord[];
  add(params: { model: string; successes: boolean[]; bucket?: string; agentName?: string }): void;
}

/** Stored runs of routed tasks: each outcome is a completed run the agent claimed (success) or a failed one. */
function runsBuilder(): RunsBuilder {
  const runs: RunRecord[] = [];
  return {
    runs,
    add: ({ model, successes, bucket = BUCKET, agentName = 'helper' }) => {
      for (const isSuccess of successes) {
        const startedAt = runs.length + 1;
        const run = fixtureRun({ startedAt, runId: `run_${startedAt}`, agentName, model, status: isSuccess ? 'completed' : 'failed', claimedSuccess: isSuccess ? 1 : 0 });
        runs.push({ ...run, route: { model, reason: 'default', evidence: { bucket, minSamples: 20 }, alternatives: [] } });
      }
    },
  };
}

/** `count` outcomes with exactly `rate` of them successes, spread evenly (no randomness, so expectations are exact). */
function outcomes(params: { count: number; rate: number }): boolean[] {
  const { count, rate } = params;
  return Array.from({ length: count }, (_, position) => Math.floor((position + 1) * rate) > Math.floor(position * rate));
}

function router(params: { runs: RunRecord[]; options?: RoutingOptions; seed?: number }) {
  const { runs, options, seed = 1 } = params;
  return createModelRouter({ random: createSeededRandom(seed), readRuns: async () => runs, ...(options == null ? {} : { options }) });
}

const choose = (params: { routerOf: ReturnType<typeof router>; priority?: 'speed' | 'cost' | 'quality'; features?: TaskFeatures }) => params.routerOf.choose({
  agentName: 'helper', agentVersion: 'v1', features: params.features ?? FEATURES, routes: ROUTES, now: 0, ...(params.priority == null ? {} : { priority: params.priority }),
});

describe('createModelRouter', () => {
  it('uses default without learning, whatever the statistics say', async () => {
    const built = runsBuilder();
    built.add({ model: 'p:small', successes: outcomes({ count: 40, rate: 1 }) });
    built.add({ model: 'p:big', successes: outcomes({ count: 40, rate: 0.5 }) });
    const decision = await choose({ routerOf: router({ runs: built.runs }) });
    expect(decision).toMatchObject({ model: 'p:big', reason: 'default', evidence: { bucket: BUCKET } });
    expect(decision.alternatives).toEqual([
      { model: 'p:big', successRate: 0.5, meanCostUsd: 0, n: 40 },
      { model: 'p:huge', successRate: 0, meanCostUsd: 0, n: 0 },
      { model: 'p:small', successRate: 1, meanCostUsd: 0, n: 40 },
    ]);
  });

  it('always sends quality tasks to the capable model', async () => {
    expect(await choose({ routerOf: router({ runs: [], options: {} }), priority: 'quality' })).toMatchObject({ model: 'p:huge', reason: 'priority-quality' });
  });

  it('keeps default before every model has the minimum samples, and explores at most the configured share', async () => {
    const built = runsBuilder();
    built.add({ model: 'p:big', successes: outcomes({ count: 30, rate: 0.6 }) });
    built.add({ model: 'p:small', successes: outcomes({ count: 19, rate: 1 }) });
    const routerOf = router({ runs: built.runs, options: { maxExploration: 0.1 } });
    const decisions = await Promise.all(Array.from({ length: 2_000 }, () => choose({ routerOf })));
    expect(decisions.some(({ reason }) => reason === 'learned')).toBe(false);
    const explored = decisions.filter(({ reason }) => reason === 'explore');
    // The least-tried unproven model is explored: p:huge has no runs.
    expect(new Set(explored.map(({ model }) => model))).toEqual(new Set(['p:huge']));
    // Binomial(2000, 0.1): mean 200, sd 13.4; 260 is 4.5 sd above.
    expect(explored.length).toBeLessThan(260);
    expect(explored.length).toBeGreaterThan(140);
  });

  it('reproduces its exploration choices with the same seed', async () => {
    const reasons = async (seed: number): Promise<string[]> => {
      const routerOf = router({ runs: [], options: { maxExploration: 0.5 }, seed });
      return Promise.all(Array.from({ length: 50 }, async () => (await choose({ routerOf })).reason));
    };
    expect(await reasons(3)).toEqual(await reasons(3));
    expect(await reasons(3)).not.toEqual(await reasons(4));
  });

  it('never explores for unattended tasks', async () => {
    const routerOf = router({ runs: [], options: { maxExploration: 1 } });
    const unattended = extractTaskFeatures({ task: 'find the readme', unattended: true });
    expect(await choose({ routerOf, features: unattended })).toMatchObject({ reason: 'default', model: 'p:big' });
  });

  it('learns the better model once every model is proven', async () => {
    const built = runsBuilder();
    built.add({ model: 'p:big', successes: outcomes({ count: 60, rate: 0.6 }) });
    built.add({ model: 'p:small', successes: outcomes({ count: 60, rate: 0.95 }) });
    built.add({ model: 'p:huge', successes: outcomes({ count: 60, rate: 0.7 }) });
    expect(await choose({ routerOf: router({ runs: built.runs, options: {} }) })).toMatchObject({ model: 'p:small', reason: 'learned' });
  });

  it('counts a user verdict over the agent claim', async () => {
    const built = runsBuilder();
    built.add({ model: 'p:big', successes: outcomes({ count: 40, rate: 0.7 }) });
    built.add({ model: 'p:huge', successes: outcomes({ count: 40, rate: 0.7 }) });
    built.add({ model: 'p:small', successes: outcomes({ count: 40, rate: 1 }) });
    // The users rated every one of the cheap model's claimed successes incorrect.
    const rated = built.runs.map(run => (run.model === 'p:small' ? { ...run, userVerdict: 'incorrect' as const } : run));
    expect(await choose({ routerOf: router({ runs: rated, options: {} }) })).not.toMatchObject({ model: 'p:small' });
  });

  it('prefers the cheap model for cost tasks only when its lower bound clears the bar', async () => {
    const strong = runsBuilder();
    strong.add({ model: 'p:big', successes: outcomes({ count: 100, rate: 0.9 }) });
    strong.add({ model: 'p:small', successes: outcomes({ count: 100, rate: 0.9 }) });
    const accepted = await choose({ routerOf: router({ runs: strong.runs }), priority: 'cost' });
    expect(accepted).toMatchObject({ model: 'p:small', reason: 'priority-cost' });
    // Wilson lower bound of 90/100 is 0.8256; the bar is 0.85 x 0.9 = 0.765.
    expect(accepted.evidence?.lowerBound).toBeCloseTo(0.8256, 3);
    expect(accepted.evidence?.bar).toBeCloseTo(0.765, 6);
    const weak = runsBuilder();
    weak.add({ model: 'p:big', successes: outcomes({ count: 100, rate: 0.9 }) });
    weak.add({ model: 'p:small', successes: outcomes({ count: 25, rate: 0.84 }) });
    expect(await choose({ routerOf: router({ runs: weak.runs }), priority: 'cost' })).toMatchObject({ model: 'p:big', reason: 'default' });
  });

  it('counts a rated run once in the confidence bound: verdicts weigh the rate, not the sample size', async () => {
    const built = runsBuilder();
    built.add({ model: 'p:big', successes: outcomes({ count: 20, rate: 1 }) });
    built.add({ model: 'p:small', successes: outcomes({ count: 20, rate: 1 }) });
    const rated = built.runs.map(run => ({ ...run, userVerdict: 'correct' as const }));
    // 20 of 20: the Wilson lower bound is 0.839, short of the bar 0.85 x 1, rated or not.
    const decision = await choose({ routerOf: router({ runs: rated }), priority: 'cost' });
    expect(decision).toMatchObject({ model: 'p:big', reason: 'default' });
    const unrated = await choose({ routerOf: router({ runs: built.runs }), priority: 'cost' });
    expect(unrated).toMatchObject({ model: 'p:big', reason: 'default' });
  });

  it('reverts a learned model that degrades, cools down, then learns again', async () => {
    const built = runsBuilder();
    built.add({ model: 'p:big', successes: outcomes({ count: 60, rate: 0.6 }) });
    built.add({ model: 'p:huge', successes: outcomes({ count: 60, rate: 0.6 }) });
    built.add({ model: 'p:small', successes: outcomes({ count: 60, rate: 0.95 }) });
    const routerOf = router({ runs: built.runs, options: { cooldownRuns: 3 } });
    expect(await choose({ routerOf })).toMatchObject({ model: 'p:small', reason: 'learned' });
    // Its last 30 runs fall to 0.7: 0.25 below its earlier 0.95.
    built.add({ model: 'p:small', successes: outcomes({ count: 30, rate: 0.7 }) });
    const reverted = await choose({ routerOf });
    expect(reverted).toMatchObject({ model: 'p:big', reason: 'default', evidence: { reverted: { model: 'p:small' }, cooldownRunsLeft: 3 } });
    expect(reverted.evidence?.reverted?.earlierRate).toBeCloseTo(0.95, 6);
    expect(reverted.evidence?.reverted?.recentRate).toBeCloseTo(0.7, 6);
    for (let left = 2; left >= 0; left -= 1) expect(await choose({ routerOf })).toMatchObject({ model: 'p:big', evidence: { cooldownRunsLeft: left } });
    // The model recovers: 30 good runs, so its recent window matches its earlier rate again.
    built.add({ model: 'p:small', successes: outcomes({ count: 30, rate: 0.95 }) });
    expect(await choose({ routerOf })).toMatchObject({ model: 'p:small', reason: 'learned' });
  });

  it('puts a reverted model on probation after its cooldown instead of reverting it again on the same runs', async () => {
    const built = runsBuilder();
    built.add({ model: 'p:big', successes: outcomes({ count: 60, rate: 0.6 }) });
    built.add({ model: 'p:huge', successes: outcomes({ count: 60, rate: 0.6 }) });
    built.add({ model: 'p:small', successes: outcomes({ count: 60, rate: 0.95 }) });
    built.add({ model: 'p:small', successes: outcomes({ count: 30, rate: 0.7 }) });
    const routerOf = router({ runs: built.runs, options: { cooldownRuns: 1 } });
    expect(await choose({ routerOf })).toMatchObject({ model: 'p:big', evidence: { reverted: { model: 'p:small' } } });
    expect(await choose({ routerOf })).toMatchObject({ model: 'p:big', evidence: { cooldownRunsLeft: 0 } });
    // No new runs of p:small: the window that reverted it cannot revert it twice.
    expect(await choose({ routerOf })).toMatchObject({ model: 'p:small', reason: 'learned' });
    // A fresh window as bad as the first reverts it again.
    built.add({ model: 'p:small', successes: outcomes({ count: 30, rate: 0.5 }) });
    expect(await choose({ routerOf })).toMatchObject({ model: 'p:big', evidence: { reverted: { model: 'p:small' } } });
  });

  it('does not revert on a drop that chance explains', async () => {
    const built = runsBuilder();
    built.add({ model: 'p:big', successes: outcomes({ count: 60, rate: 0.6 }) });
    built.add({ model: 'p:huge', successes: outcomes({ count: 60, rate: 0.6 }) });
    // 0.9 earlier, then 23 of 30: 0.133 lower, more than revertDrop, but one-sided p is about 0.04.
    built.add({ model: 'p:small', successes: outcomes({ count: 60, rate: 0.9 }) });
    built.add({ model: 'p:small', successes: outcomes({ count: 30, rate: 23 / 30 }) });
    expect(await choose({ routerOf: router({ runs: built.runs, options: {} }) })).toMatchObject({ model: 'p:small', reason: 'learned' });
  });

  it('keeps a stable better model through noisy windows: no lock-out after a spurious revert (simulation)', async () => {
    const rates: Record<string, number> = { 'p:big': 0.7, 'p:small': 0.9 };
    const routes: ModelRoutes = { default: 'p:big', cheap: 'p:small' };
    const shares: number[] = [];
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const built = runsBuilder();
      built.add({ model: 'p:big', successes: outcomes({ count: 20, rate: rates['p:big'] as number }) });
      built.add({ model: 'p:small', successes: outcomes({ count: 20, rate: rates['p:small'] as number }) });
      const routerOf = router({ runs: built.runs, options: {}, seed });
      const world = createSeededRandom(1_000 + seed);
      const chosen: string[] = [];
      for (let choice = 0; choice < 2_000; choice += 1) {
        const { model } = await routerOf.choose({ agentName: 'helper', agentVersion: 'v1', features: FEATURES, routes, now: 0 });
        chosen.push(model);
        built.add({ model, successes: [world() < (rates[model] as number)] });
      }
      shares.push(chosen.slice(-1_000).filter(model => model === 'p:small').length / 1_000);
    }
    // Nothing about either model changes, so the better one must keep nearly all of the traffic in every world.
    for (const share of shares) expect(share).toBeGreaterThan(0.85);
  }, 120_000);

  it('still moves traffic off a learned model that really degrades (simulation)', async () => {
    const routes: ModelRoutes = { default: 'p:big', cheap: 'p:small' };
    for (const seed of [1, 2, 3]) {
      const built = runsBuilder();
      built.add({ model: 'p:big', successes: outcomes({ count: 40, rate: 0.7 }) });
      built.add({ model: 'p:small', successes: outcomes({ count: 200, rate: 0.95 }) });
      const routerOf = router({ runs: built.runs, options: {}, seed });
      const world = createSeededRandom(2_000 + seed);
      // From now on the learned model succeeds only 40% of the time.
      const rates: Record<string, number> = { 'p:big': 0.7, 'p:small': 0.4 };
      const chosen: string[] = [];
      for (let choice = 0; choice < 600; choice += 1) {
        const { model } = await routerOf.choose({ agentName: 'helper', agentVersion: 'v1', features: FEATURES, routes, now: 0 });
        chosen.push(model);
        built.add({ model, successes: [world() < (rates[model] as number)] });
      }
      // Each probation costs a fresh window on the bad model, so the default keeps most, not all, of the traffic.
      expect(chosen.slice(-300).filter(model => model === 'p:big').length / 300).toBeGreaterThan(0.55);
    }
  }, 120_000);

  it('keeps statistics per agent and per bucket', async () => {
    const built = runsBuilder();
    built.add({ model: 'p:small', successes: outcomes({ count: 60, rate: 1 }), agentName: 'other' });
    built.add({ model: 'p:small', successes: outcomes({ count: 60, rate: 1 }), bucket: 'long:edit' });
    const decision = await choose({ routerOf: router({ runs: built.runs, options: {} }) });
    expect(decision.alternatives.every(({ n }) => n === 0)).toBe(true);
  });

  it('never makes a learned choice while any model is short of samples, whatever the outcomes (property)', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.boolean(), { maxLength: 19 }), fc.array(fc.boolean(), { minLength: 20, maxLength: 60 }), fc.array(fc.boolean(), { minLength: 20, maxLength: 60 }), fc.integer({ min: 0, max: 1_000 }),
      async (shortArm, big, huge, seed) => {
        const built = runsBuilder();
        built.add({ model: 'p:small', successes: shortArm });
        built.add({ model: 'p:big', successes: big });
        built.add({ model: 'p:huge', successes: huge });
        const decision = await choose({ routerOf: router({ runs: built.runs, options: {}, seed }), priority: 'cost' });
        expect(decision.reason === 'learned' || decision.reason === 'priority-cost').toBe(false);
      },
    ), { numRuns: 200 });
  });

  it('is not flipped by one more run once the evidence is clear (property)', async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.constantFrom('p:big', 'p:small', 'p:huge'), async (isSuccess, model) => {
      const built = runsBuilder();
      built.add({ model: 'p:big', successes: outcomes({ count: 60, rate: 0.6 }) });
      built.add({ model: 'p:huge', successes: outcomes({ count: 60, rate: 0.65 }) });
      built.add({ model: 'p:small', successes: outcomes({ count: 60, rate: 0.95 }) });
      built.add({ model, successes: [isSuccess] });
      expect(await choose({ routerOf: router({ runs: built.runs, options: {} }) })).toMatchObject({ model: 'p:small', reason: 'learned' });
    }), { numRuns: 30 });
  });
});
