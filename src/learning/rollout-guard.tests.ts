import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../telemetry/run-record.js';
import { evaluateActive, evaluateTrial, perLookAlpha, summariseArm } from './rollout-guard.js';
import type { TrialVerdict } from './rollout-guard.js';
import { OPTIONS, strategyRun, trialStream, variantFixture } from './strategy.test-support.js';

const SEEDS = Array.from({ length: 40 }, (_, index) => index + 1);
const variant = variantFixture();

/** Walks a stream run by run, as the runtime does (a look at every run start), until the guard decides. */
function firstDecision(runs: RunRecord[]): TrialVerdict & { afterRuns: number } {
  for (let count = 1; count <= runs.length; count += 1) {
    const verdict = evaluateTrial({ variant, runs: runs.slice(0, count), options: OPTIONS });
    if (verdict.action !== 'continue') return { ...verdict, afterRuns: count };
  }
  return { ...evaluateTrial({ variant, runs, options: OPTIONS }), afterRuns: runs.length };
}

describe('evaluateTrial (simulated A/B streams)', () => {
  it('promotes a clearly better variant', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      expect(firstDecision(trialStream({ variant, trialRate: 0.9, controlRate: 0.6, seed, runs: 600 })).action).toBe('promote');
    }
  });

  it('rarely promotes an equal variant, even looking after every run (alpha is split over the looks)', () => {
    const promoted = SEEDS.filter(seed => firstDecision(trialStream({ variant, trialRate: 0.7, controlRate: 0.7, seed, runs: 600 })).action === 'promote');
    // The guard's false-promotion rate is at most alpha (0.05): 2 of 40 expected at worst; 5 would be far outside.
    expect(promoted.length).toBeLessThan(5);
  });

  it('never promotes a worse variant, and rejects it', () => {
    for (const seed of SEEDS) {
      const decision = firstDecision(trialStream({ variant, trialRate: 0.5, controlRate: 0.8, seed, runs: 600 }));
      expect(decision.action).toBe('reject');
    }
  });

  it('never decides before minSamples runs per arm, whatever the outcomes', () => {
    const lucky = trialStream({ variant, trialRate: 1, controlRate: 0, seed: 1, runs: 40 });
    expect(evaluateTrial({ variant, runs: lucky, options: OPTIONS })).toMatchObject({ action: 'continue' });
  });

  it('does not promote a better variant that costs more than 10% extra tokens', () => {
    const runs = trialStream({ variant, trialRate: 0.95, controlRate: 0.6, seed: 3, runs: 400, trialTokens: 1_200 });
    expect(evaluateTrial({ variant, runs, options: OPTIONS })).toMatchObject({ action: 'continue', reason: 'better but less efficient so far' });
  });

  it('lets user verdicts outrank the agent claims', () => {
    // The trial arm claims success on every run, but its users rated the answers incorrect.
    const runs = trialStream({ variant, trialRate: 1, controlRate: 0.6, seed: 4, runs: 400 })
      .map(run => (run.strategy?.arm === 'trial' ? { ...run, userVerdict: 'incorrect' as const } : run));
    expect(evaluateTrial({ variant, runs, options: OPTIONS }).action).toBe('reject');
  });

  it('splits alpha over the planned looks', () => {
    expect(perLookAlpha(OPTIONS)).toBeCloseTo(0.005, 9);
  });
});

describe('summariseArm', () => {
  it('measures efficiency on good answers only, never on runs rated incorrect, and leaves dry runs out', () => {
    const strategy = { bucket: 'b', arm: 'trial' as const, activeVariantIds: [] };
    const good = strategyRun({ index: 1, isSuccess: true, strategy, tokens: 100, turns: 1 });
    const rated = { ...strategyRun({ index: 2, isSuccess: true, strategy, tokens: 10, turns: 9 }), userVerdict: 'incorrect' as const };
    const dry = { ...strategyRun({ index: 3, isSuccess: true, strategy }), dryRun: true as const };
    expect(summariseArm([good, rated, dry])).toEqual({ runs: 2, rate: 1 / 3, meanTokens: 100, meanTurns: 1 });
  });
});

describe('evaluateActive (rollout guard)', () => {
  // Fixture runs are recorded 1,000 ms after they start, so a run started at index i is recorded at i + 1,000.
  const active = variantFixture({ status: 'active', promotedAt: 2_000, baselineRate: 0.8 });
  const activeRuns = (params: { rate: number; count: number; from: number }): RunRecord[] => Array.from({ length: params.count }, (_, offset) => strategyRun({
    index: params.from + offset, isSuccess: Math.floor((offset + 1) * params.rate) > Math.floor(offset * params.rate),
    strategy: { bucket: 'b', arm: 'control', activeVariantIds: [active.id] },
  }));

  it('reverts a promoted variant whose recent success falls below its baseline minus the tolerance', () => {
    const degraded = activeRuns({ rate: 0.5, count: 30, from: 1_000 });
    expect(evaluateActive({ variant: active, runs: degraded, options: OPTIONS })).toMatchObject({ action: 'revert' });
  });

  it('keeps one holding its baseline, and waits for a full window', () => {
    expect(evaluateActive({ variant: active, runs: activeRuns({ rate: 1, count: 30, from: 1_000 }), options: OPTIONS }).action).toBe('keep');
    expect(evaluateActive({ variant: active, runs: activeRuns({ rate: 0, count: 29, from: 1_000 }), options: OPTIONS })).toMatchObject({ action: 'keep', reason: '29 of 30 runs since promotion' });
  });

  it('ignores runs from before the promotion', () => {
    expect(evaluateActive({ variant: active, runs: activeRuns({ rate: 0, count: 30, from: 900 }), options: OPTIONS }).action).toBe('keep');
  });
});
