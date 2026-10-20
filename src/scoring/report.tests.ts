import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RunTrace } from '../telemetry/run-record.js';
import { fixtureTrace } from './fixtures.test-support.js';
import type { FixtureRunParams } from './fixtures.test-support.js';
import { buildReport } from './report.js';

const GENERATED_AT = 9_999;

function series(count: number, run: Omit<FixtureRunParams, 'startedAt'> & { firstStartedAt?: number }): RunTrace[] {
  const { firstStartedAt = 1, ...rest } = run;
  return Array.from({ length: count }, (_, offset) => fixtureTrace({ run: { ...rest, startedAt: firstStartedAt + offset } }));
}

function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(numbersIn);
  return [];
}

describe('buildReport', () => {
  it('reports nothing, safely, for no runs', () => {
    expect(buildReport({ traces: [], filter: {}, generatedAt: GENERATED_AT })).toEqual({
      generatedAt: GENERATED_AT, filter: { minRuns: 5 }, runCount: 0, agents: [], findings: [], requests: [], toolSuggestions: [], agentFeedback: [],
      cache: { hottest: [], hitRateByTool: {}, hitRateByAgent: {}, worthMarkingDeterministic: [], frequentlyInvalidated: [] },
    });
  });

  it('fills cache findings from the stored entries and the selected runs\' repeated uncached calls', () => {
    const repeated = [{ tool: 'lookup', argsHash: 'h' }, { tool: 'lookup', argsHash: 'h' }, { tool: 'lookup', argsHash: 'h' }];
    const traces = [fixtureTrace({ run: { startedAt: 1 }, steps: repeated }), fixtureTrace({ run: { startedAt: 2 }, steps: repeated })];
    const stats = { firstStoredBy: { agentName: 'helper', runId: 'r' }, totalHits: 2, hitsByAgent: { helper: 2 }, missesByAgent: { helper: 1 }, lastRequestedAt: 0, missCount: 1, invalidationCount: 0, savedMs: 30, savedTokens: 4 };
    const cacheEntries = [{ key: 'global:k', value: { schemaVersion: 1 as const, namespace: 'global', tool: 'read', storedAt: 0, value: 'x', bytes: 3, originalDurationMs: 15, resultTokens: 2, stats } }];
    const { cache } = buildReport({ traces, cacheEntries, filter: {}, generatedAt: GENERATED_AT });
    expect(cache).toEqual({
      hottest: [{ tool: 'read', key: 'global:k', hits: 2, savedMs: 30 }],
      hitRateByTool: { read: 2 / 3 },
      hitRateByAgent: { helper: 2 / 3 },
      worthMarkingDeterministic: [{ tool: 'lookup', repeatedIdenticalCalls: 6 }],
      frequentlyInvalidated: [],
    });
    expect(buildReport({ traces, cacheEntries, filter: { since: 2 }, generatedAt: GENERATED_AT }).cache.worthMarkingDeterministic).toEqual([]);
  });

  it('summarises each agent version: totals, medians, p90s and scores', () => {
    const traces = [...series(5, { durationMs: 1_000 }), ...series(5, { firstStartedAt: 10, durationMs: 500, turns: 2, toolCalls: 4 })];
    const report = buildReport({ traces, filter: {}, generatedAt: GENERATED_AT, pricing: { 'fake:m': { inputPerMTokUsd: 1, outputPerMTokUsd: 1 } } });
    expect(report.runCount).toBe(10);
    expect(report.agents).toHaveLength(1);
    const [agent] = report.agents;
    expect(agent).toMatchObject({
      agentName: 'helper', agentVersion: 'v1', runs: 10,
      totals: { tokens: 10_000, costUsd: 0.01, durationMs: 7_500, turns: 20, toolCalls: 40 },
      medians: { durationMs: 750, tokens: 1_000, turns: 2, toolCalls: 4, toolCallsPerTurn: 2, costUsd: 0.001 },
      p90s: { durationMs: 1_000, tokens: 1_000, turns: 2, toolCalls: 4, toolCallsPerTurn: 2, costUsd: 0.001 },
    });
    // The five 500 ms runs each have five or more earlier runs; their baselines contain the 1,000 ms runs.
    expect(agent?.scores.speed).toMatchObject({ value: expect.any(Number), label: 'fast' });
    expect(agent?.scores.cost.value).toBe(50);
  });

  it('keeps agent versions apart and sorts them', () => {
    const traces = [...series(2, { agentName: 'zed' }), ...series(2, { agentVersion: 'v2', firstStartedAt: 5 }), ...series(2, { firstStartedAt: 9 })];
    expect(buildReport({ traces, filter: {}, generatedAt: GENERATED_AT }).agents.map(({ agentName, agentVersion, runs }) => [agentName, agentVersion, runs])).toEqual([
      ['helper', 'v1', 2], ['helper', 'v2', 2], ['zed', 'v1', 2],
    ]);
  });

  it.each([
    [{ agentName: 'zed' }, ['run_0020']],
    [{ instanceId: 'i9' }, ['run_0021']],
    [{ agentVersion: 'v2' }, ['run_0022']],
    [{ agentVersion: 'label-b' }, ['run_0022']],
    [{ since: 23 }, ['run_0023', 'run_0024']],
    [{ label: 'nightly' }, ['run_0023']],
    [{ unattended: true }, ['run_0024']],
    [{ includeDisabled: false as const, agentName: 'zed' }, ['run_0020']],
  ])('filters by %j', (filter, runIds) => {
    const traces = [
      fixtureTrace({ run: { startedAt: 20, agentName: 'zed' } }),
      fixtureTrace({ run: { startedAt: 21, instanceId: 'i9' } }),
      fixtureTrace({ run: { startedAt: 22, agentVersion: 'v2', version: 'label-b' } }),
      fixtureTrace({ run: { startedAt: 23, label: 'nightly' } }),
      fixtureTrace({ run: { startedAt: 24, unattended: true } }),
    ];
    const report = buildReport({ traces, filter, generatedAt: GENERATED_AT });
    expect(report.runCount).toBe(runIds.length);
    expect(report.filter).toEqual({ minRuns: 5, ...filter });
  });

  it('scores filtered runs against their whole history, not just the filtered slice', () => {
    const traces = [...series(6, { durationMs: 1_000 }), fixtureTrace({ run: { startedAt: 50, durationMs: 500 } })];
    const report = buildReport({ traces, filter: { since: 50 }, generatedAt: GENERATED_AT });
    expect(report.runCount).toBe(1);
    expect(report.agents[0]?.scores.speed).toMatchObject({ value: 100, label: 'fast' });
  });

  it('compares two versions by hash or label', () => {
    const traces = [
      ...series(3, { agentVersion: 'aaa', version: 'before', durationMs: 1_000, inputTokens: 1_000, turns: 4, toolCalls: 4 }),
      ...series(3, { agentVersion: 'bbb', version: 'after', firstStartedAt: 10, durationMs: 400, inputTokens: 700, turns: 2, toolCalls: 4, status: 'failed' }),
    ];
    const pricing = { 'fake:m': { inputPerMTokUsd: 1, outputPerMTokUsd: 1 } };
    const { comparison } = buildReport({ traces, filter: { compareVersions: ['before', 'bbb'] }, generatedAt: GENERATED_AT, pricing });
    expect(comparison).toEqual({
      before: { version: 'before', runs: 3, medians: { durationMs: 1_000, tokens: 1_000, turns: 4, toolCallsPerTurn: 1, costUsd: 0.001, reliability: 100 } },
      after: { version: 'bbb', runs: 3, medians: { durationMs: 400, tokens: 700, turns: 2, toolCallsPerTurn: 2, costUsd: 0.0007, reliability: 0 } },
      deltas: { durationMs: -600, tokens: -300, turns: -2, toolCallsPerTurn: 1, costUsd: -0.0003, reliability: -100 },
    });
  });

  it('reports nulls, not errors, when a compared version has no runs', () => {
    const { comparison } = buildReport({ traces: series(2, {}), filter: { compareVersions: ['v1', 'missing'] }, generatedAt: GENERATED_AT });
    expect(comparison?.after).toEqual({ version: 'missing', runs: 0, medians: { durationMs: null, tokens: null, turns: null, toolCallsPerTurn: null, costUsd: null, reliability: null } });
    expect(comparison?.deltas).toEqual({ durationMs: null, tokens: null, turns: null, toolCallsPerTurn: null, costUsd: null, reliability: null });
  });

  it('never contains NaN or Infinity (property)', () => {
    const runArbitrary = fc.record({
      startedAt: fc.integer({ min: 0, max: 40 }),
      agentName: fc.constantFrom('a', 'b'),
      agentVersion: fc.constantFrom('v1', 'v2'),
      durationMs: fc.integer({ min: 0, max: 5_000 }),
      inputTokens: fc.integer({ min: 0, max: 3_000 }),
      cachedTokens: fc.integer({ min: 0, max: 3_000 }),
      turns: fc.integer({ min: 0, max: 20 }),
      toolCalls: fc.integer({ min: 0, max: 40 }),
      retries: fc.integer({ min: 0, max: 3 }),
    });
    const stepArbitrary = fc.record({ tool: fc.constantFrom('read', 'search'), durationMs: fc.integer({ min: 0, max: 9_000 }), resultTokens: fc.integer({ min: 0, max: 9_000 }), ok: fc.boolean(), truncated: fc.boolean() });
    fc.assert(fc.property(fc.array(fc.tuple(runArbitrary, fc.array(stepArbitrary, { maxLength: 6 })), { maxLength: 15 }), fc.boolean(), (specs, withPricing) => {
      const traces = specs.map(([run, steps], position) => fixtureTrace({ run: { ...run, runId: `r${position}` }, steps }));
      const report = buildReport({
        traces, filter: { compareVersions: ['v1', 'v2'], minRuns: 2 }, generatedAt: GENERATED_AT,
        ...(withPricing ? { pricing: { 'fake:m': { inputPerMTokUsd: 2, outputPerMTokUsd: 4 } } } : {}),
      });
      for (const number of numbersIn(report)) expect(Number.isFinite(number)).toBe(true);
    }), { numRuns: 150 });
  });
});
