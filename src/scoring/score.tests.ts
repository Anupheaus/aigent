import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../telemetry/run-record.js';
import { fixtureRun, fixtureSeries } from './fixtures.test-support.js';
import { scoreRuns } from './score.js';

/** Five earlier runs of 1 s, 1,000 input tokens, 2 turns of 4 calls, no failures. */
const BASELINE = fixtureSeries({ count: 5, firstStartedAt: 1 });
const PRICING = { 'fake:m': { inputPerMTokUsd: 1, outputPerMTokUsd: 2 } };

function scoreOne(run: RunRecord, baseline: RunRecord[] = BASELINE) {
  return scoreRuns({ runs: [run], baseline: [...baseline, run] });
}

/** Every number anywhere in the value, so NaN or Infinity cannot hide in a nested field. */
function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(numbersIn);
  return [];
}

describe('scoreRuns speed', () => {
  it.each([
    [500, 100, 'fast'],
    [800, 62.5, 'fast'],
    [1_000, 50, 'average'],
    [2_000, 25, 'slow'],
  ])('a %d ms run against a 1,000 ms baseline scores %d (%s)', (durationMs, value, label) => {
    expect(scoreOne(fixtureRun({ startedAt: 10, durationMs })).speed).toMatchObject({ value, label });
  });

  it('averages per-run scores and explains them', () => {
    const fast = fixtureRun({ startedAt: 10, durationMs: 500 });
    const slow = fixtureRun({ startedAt: 11, durationMs: 2_000 });
    const { speed } = scoreRuns({ runs: [fast, slow], baseline: [...BASELINE, fast, slow] });
    expect(speed.value).toBe(62.5);
    expect(speed.evidence).toBe('2 of 2 runs scored against up to 50 earlier runs of this version; median duration 1,250 ms vs baseline median 1,000 ms');
  });

  it('needs minRuns earlier runs, counting only runs that started before', () => {
    const run = fixtureRun({ startedAt: 10 });
    expect(scoreOne(run, BASELINE.slice(0, 4)).speed).toEqual({ value: null, label: 'insufficient-data', evidence: 'No run had the 5 earlier runs of this version a score needs (0 of 1 scored)' });
    expect(scoreRuns({ runs: [run], baseline: [...BASELINE.slice(0, 4), run], minRuns: 4 }).speed.value).toBe(50);
    const early = fixtureRun({ startedAt: 0 });
    expect(scoreRuns({ runs: [early], baseline: [early, ...BASELINE] }).speed.value).toBeNull();
  });

  it('moves with the baseline', () => {
    const run = fixtureRun({ startedAt: 10, durationMs: 1_000 });
    expect(scoreOne(run).speed.value).toBe(50);
    expect(scoreOne(run, fixtureSeries({ count: 5, firstStartedAt: 1, run: { durationMs: 2_000 } })).speed.value).toBe(100);
  });

  it('uses only the 50 most recent earlier runs', () => {
    const old = fixtureSeries({ count: 60, firstStartedAt: 1, run: { durationMs: 10_000 } });
    const recent = fixtureSeries({ count: 50, firstStartedAt: 100, run: { durationMs: 1_000 } });
    expect(scoreOne(fixtureRun({ startedAt: 200 }), [...old, ...recent]).speed.value).toBe(50);
  });

  it('handles zero durations without dividing by zero', () => {
    const instant = fixtureSeries({ count: 5, firstStartedAt: 1, run: { durationMs: 0 } });
    expect(scoreOne(fixtureRun({ startedAt: 10, durationMs: 0 }), instant).speed.value).toBe(50);
    expect(scoreOne(fixtureRun({ startedAt: 10, durationMs: 5 }), instant).speed.value).toBe(0);
    expect(scoreOne(fixtureRun({ startedAt: 10, durationMs: 0 })).speed.value).toBe(100);
  });
});

describe('scoreRuns token, turn and tool efficiency', () => {
  it('weights cached input tokens at 0.1', () => {
    const run = fixtureRun({ startedAt: 10, inputTokens: 1_000, cachedTokens: 500 });
    expect(scoreOne(run).tokenEfficiency).toMatchObject({ value: 90.9, label: 'efficient' });
  });

  it('scores 50 tool calls in 3 turns above 50 tool calls in 45 turns', () => {
    const baseline = fixtureSeries({ count: 5, firstStartedAt: 1, run: { turns: 10, toolCalls: 50 } });
    const fewTurns = scoreOne(fixtureRun({ startedAt: 10, turns: 3, toolCalls: 50 }), baseline).turnEfficiency;
    const manyTurns = scoreOne(fixtureRun({ startedAt: 10, turns: 45, toolCalls: 50 }), baseline).turnEfficiency;
    expect(fewTurns).toMatchObject({ value: 100, label: 'efficient' });
    expect(manyTurns).toMatchObject({ value: 11.1, label: 'inefficient' });
  });

  it('rewards batching and penalises repeated calls', () => {
    const baseline = fixtureSeries({ count: 5, firstStartedAt: 1, run: { toolUse: { calls: 10, items: 10, repeats: 2 } } });
    expect(scoreOne(fixtureRun({ startedAt: 10, toolUse: { calls: 10, items: 30, repeats: 0 } }), baseline).toolEfficiency).toMatchObject({ value: 81.3, label: 'efficient' });
    expect(scoreOne(fixtureRun({ startedAt: 10, toolUse: { calls: 10, items: 10, repeats: 6 } }), baseline).toolEfficiency).toMatchObject({ value: 37.5, label: 'inefficient' });
  });

  it('leaves tool efficiency unscored for runs without tool calls', () => {
    const { toolEfficiency } = scoreOne(fixtureRun({ startedAt: 10, toolCalls: 0 }));
    expect(toolEfficiency).toEqual({ value: null, label: 'insufficient-data', evidence: 'No run had tool calls and 5 earlier runs of this version with tool calls (0 of 1 scored)' });
  });
});

describe('scoreRuns cost and reliability', () => {
  it('is null without pricing for the model, and compares cost with it', () => {
    const run = fixtureRun({ startedAt: 10, inputTokens: 500 });
    expect(scoreOne(run).cost).toEqual({ value: null, label: 'insufficient-data', evidence: "No pricing for 'fake:m'; pass createAigent({ pricing }) to score cost" });
    expect(scoreRuns({ runs: [run], baseline: [...BASELINE, run], pricing: PRICING }).cost).toMatchObject({ value: 100, label: 'efficient' });
  });

  it('counts completed runs without unusual failures, and lets the user verdict override', () => {
    const runs = [
      fixtureRun({ startedAt: 10 }),
      fixtureRun({ startedAt: 11, status: 'failed' }),
      fixtureRun({ startedAt: 12, userVerdict: 'incorrect', claimedSuccess: 3 }),
      fixtureRun({ startedAt: 13, failureCount: 2 }),
      fixtureRun({ startedAt: 14, failureCount: 2, userVerdict: 'correct' }),
    ];
    expect(scoreRuns({ runs, baseline: [...BASELINE, ...runs] }).reliability).toEqual({
      value: 40, label: 'inefficient', evidence: '2 of 5 scored runs were reliable (completed, no more tool failures than the baseline median, not rated incorrect)',
    });
  });
});

describe('scoreRuns robustness', () => {
  it('scores nothing for no runs, without throwing', () => {
    const scores = scoreRuns({ runs: [], baseline: [] });
    for (const score of Object.values(scores)) expect(score).toMatchObject({ value: null, label: 'insufficient-data' });
  });

  it('breaks start-time ties by run id, so input order never changes a score', () => {
    const tied = [fixtureRun({ startedAt: 5, runId: 'b', durationMs: 3_000 }), fixtureRun({ startedAt: 5, runId: 'a', durationMs: 100 })];
    const pool = [...BASELINE, ...tied];
    const forward = scoreRuns({ runs: tied, baseline: pool });
    expect(scoreRuns({ runs: [...tied].reverse(), baseline: [...pool].reverse() })).toEqual(forward);
  });

  it('never produces NaN or Infinity, and does not depend on input order (property)', () => {
    const runArbitrary = fc.record({
      startedAt: fc.integer({ min: 0, max: 50 }),
      durationMs: fc.integer({ min: 0, max: 5_000 }),
      inputTokens: fc.integer({ min: 0, max: 5_000 }),
      cachedTokens: fc.integer({ min: 0, max: 5_000 }),
      outputTokens: fc.integer({ min: 0, max: 500 }),
      turns: fc.integer({ min: 0, max: 30 }),
      toolCalls: fc.integer({ min: 0, max: 60 }),
      failureCount: fc.integer({ min: 0, max: 5 }),
      status: fc.constantFrom('completed', 'failed', 'limit_reached' as const),
      userVerdict: fc.option(fc.constantFrom('correct', 'incorrect', 'partial' as const), { nil: undefined }),
    });
    fc.assert(fc.property(fc.array(runArbitrary, { maxLength: 25 }), fc.boolean(), (specs, withPricing) => {
      const runs = specs.map((spec, position) => fixtureRun({ ...spec, runId: `r${position}`, status: spec.status as RunRecord['status'] }));
      const pricing = withPricing ? PRICING : undefined;
      const scores = scoreRuns({ runs, baseline: runs, minRuns: 2, ...(pricing == null ? {} : { pricing }) });
      for (const number of numbersIn(scores)) expect(Number.isFinite(number)).toBe(true);
      expect(scoreRuns({ runs: [...runs].reverse(), baseline: [...runs].reverse(), minRuns: 2, ...(pricing == null ? {} : { pricing }) })).toEqual(scores);
    }), { numRuns: 200 });
  });
});
