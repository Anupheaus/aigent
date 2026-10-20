import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RunTrace } from '../telemetry/run-record.js';
import { findFindings } from './findings.js';
import { fixtureTrace } from './fixtures.test-support.js';
import type { FixtureStepParams } from './fixtures.test-support.js';

const MIN_RUNS = 5;

/** Healthy runs: one quick, small, successful search each, two turns of two calls, no retries. */
function cleanTraces(count = 6, firstStartedAt = 1): RunTrace[] {
  return Array.from({ length: count }, (_, offset) => fixtureTrace({
    run: { startedAt: firstStartedAt + offset, turns: 2, toolCalls: 4 },
    steps: [{ tool: 'search', argsSummary: `{"query":"q${offset}"}`, durationMs: 100 }],
  }));
}

function repeated(count: number, step: FixtureStepParams): FixtureStepParams[] {
  return Array.from({ length: count }, () => step);
}

function findingsFor(extra: RunTrace[]) {
  return findFindings({ traces: [...cleanTraces(), ...extra], minRuns: MIN_RUNS });
}

describe('findFindings', () => {
  it('finds nothing in healthy runs', () => {
    expect(findFindings({ traces: cleanTraces(), minRuns: MIN_RUNS })).toEqual([]);
  });

  it('flags a shaper whose output was not smaller than its input over the agent\'s runs, and not one that saved tokens', () => {
    const traces = [1, 2].map(startedAt => fixtureTrace({
      run: { startedAt },
      steps: [{ tool: 'sh', shaped: [{ shaper: 'aliases', tokensBefore: 10, tokensAfter: 12 }, { shaper: 'fold-repeats', tokensBefore: 50, tokensAfter: 20 }] }],
    }));
    const findings = findFindings({ traces, minRuns: MIN_RUNS }).filter(({ kind }) => kind === 'net-negative-shaper');
    expect(findings).toEqual([expect.objectContaining({
      id: 'net-negative-shaper:helper:aliases', severity: 'warn', subject: 'aliases', evidence: { applications: 2, tokensBefore: 20, tokensAfter: 24 },
    })]);
  });

  it('flags each guardrail that blocked in the agent runs, with its counts and codes, and not rewrites or warnings', () => {
    const blocked = fixtureTrace({ run: { startedAt: 70 } });
    blocked.run.guardrails = [
      { guardrail: 'loop-guard', stage: 'toolCall', action: 'block', code: 'repeated_call', message: '', callId: 'c4' },
      { guardrail: 'secrets', stage: 'toolResult', action: 'rewrite', message: '' },
      { guardrail: 'pii', stage: 'output', action: 'warn', message: '' },
    ];
    const again = fixtureTrace({ run: { startedAt: 71 } });
    again.run.guardrails = [{ guardrail: 'loop-guard', stage: 'toolCall', action: 'block', code: 'repeated_call', message: '' }];
    const findings = findingsFor([blocked, again]).filter(({ kind }) => kind === 'guardrail');
    expect(findings).toEqual([expect.objectContaining({ id: 'guardrail:helper:loop-guard', severity: 'warn', evidence: { blocks: 2, runs: 2, codes: ['repeated_call'] } })]);
  });

  it('flags runs that compacted often for their length, and not a long run that compacted twice', () => {
    const frequent = fixtureTrace({ run: { startedAt: 60, turns: 10, compactions: 4 } });
    const rare = fixtureTrace({ run: { startedAt: 61, turns: 30, compactions: 2 } });
    const findings = findingsFor([frequent, rare]).filter(({ kind }) => kind === 'frequent-compaction');
    expect(findings).toEqual([expect.objectContaining({
      id: `frequent-compaction:helper:${frequent.run.runId}`, severity: 'warn', label: 'inefficient', evidence: { compactions: 4, turns: 10 },
    })]);
  });

  it('flags compression that succeeds less often than the agent\'s runs without it, or costs more time than it saves', () => {
    const record = { field: 'context' as const, originalTokens: 1_000, compressedTokens: 500, ratio: 0.5, latencyMs: 10, cacheHit: false };
    const withCompression = (startedAt: number, status: 'completed' | 'failed', latencyMs = 10) => {
      const trace = fixtureTrace({ run: { startedAt, status } });
      return { ...trace, run: { ...trace.run, compression: [{ ...record, latencyMs }] } };
    };
    const unreliable = [70, 71, 72].map(startedAt => withCompression(startedAt, startedAt === 70 ? 'completed' : 'failed'));
    expect(findingsFor(unreliable).filter(({ kind }) => kind === 'compression-net-negative')).toEqual([expect.objectContaining({
      id: 'compression-net-negative:helper:helper', severity: 'warn', evidence: expect.objectContaining({ runsWithCompression: 3, runsWithout: 6, tokensSaved: 1_500 }),
    })]);
    const slow = [withCompression(80, 'completed', 5_000)];
    expect(findingsFor(slow).filter(({ kind }) => kind === 'compression-net-negative')).toHaveLength(1);
    const healthy = [80, 81, 82].map(startedAt => withCompression(startedAt, 'completed'));
    expect(findingsFor(healthy).filter(({ kind }) => kind === 'compression-net-negative')).toEqual([]);
  });

  it('flags a tool much slower than the agent\'s other calls', () => {
    const slow = fixtureTrace({ run: { startedAt: 50 }, steps: repeated(3, { tool: 'read', durationMs: 5_000, argsSummary: '{"path":"a"}', turn: 1 }).map((step, turn) => ({ ...step, turn: turn + 1 })) });
    expect(findingsFor([slow])).toContainEqual(expect.objectContaining({
      id: 'slow-tool:helper:read', kind: 'slow-tool', severity: 'warn', label: 'slow', subject: 'read', evidence: expect.objectContaining({ calls: 3, medianDurationMs: 5_000 }),
    }));
  });

  it('flags failing tools, worse at half or more of calls', () => {
    const failing = fixtureTrace({ run: { startedAt: 50 }, steps: [
      { tool: 'fetch', ok: false, errorCategory: 'timeout', errorCode: 'tool_timeout', turn: 1 },
      { tool: 'fetch', ok: false, errorCategory: 'timeout', errorCode: 'tool_timeout', turn: 2 },
      { tool: 'fetch', turn: 3 },
      { tool: 'fetch', turn: 4 },
    ] });
    expect(findingsFor([failing])).toContainEqual(expect.objectContaining({
      id: 'failing-tool:helper:fetch', severity: 'bad', label: 'inefficient', evidence: expect.objectContaining({ calls: 4, failures: 2, failureRate: 0.5, commonErrorCategory: 'timeout' }),
    }));
  });

  it('flags tools returning very large results', () => {
    const verbose = fixtureTrace({ run: { startedAt: 50 }, steps: [1, 2, 3].map(turn => ({ tool: 'dump', resultTokens: 5_000, turn })) });
    expect(findingsFor([verbose])).toContainEqual(expect.objectContaining({ id: 'verbose-tool:helper:dump', kind: 'verbose-tool', evidence: expect.objectContaining({ medianResultTokens: 5_000 }) }));
  });

  it('flags the same tool called three times with similar arguments in separate calls of one run', () => {
    const unbatched = fixtureTrace({ run: { startedAt: 50 }, steps: ['a', 'b', 'c'].map((path, turn) => ({ tool: 'read', argsSummary: `{"path":"${path}"}`, turn: turn + 1 })) });
    expect(findingsFor([unbatched])).toContainEqual(expect.objectContaining({
      id: 'unbatched-repeats:helper:read', kind: 'unbatched-repeats', label: 'inefficient', evidence: expect.objectContaining({ runIds: ['run_0050'], maxCallsInOneRun: 3 }),
    }));
  });

  it('does not count calls batched inside aigent_multi as unbatched', () => {
    const batched = fixtureTrace({ run: { startedAt: 50 }, steps: [{ tool: 'aigent_multi' }, ...['a', 'b', 'c'].map(path => ({ tool: 'read', parentCallId: 'c0', argsSummary: `{"path":"${path}"}` }))] });
    expect(findingsFor([batched]).map(({ kind }) => kind)).not.toContain('unbatched-repeats');
  });

  it('flags runs with many turns of few calls, high retry rates and claimed success the user rejected', () => {
    const traces = [
      fixtureTrace({ run: { startedAt: 50, turns: 8, toolCalls: 8 } }),
      fixtureTrace({ run: { startedAt: 51, turns: 2, retries: 6 } }),
      fixtureTrace({ run: { startedAt: 52, userVerdict: 'incorrect', claimedSuccess: 2 } }),
    ];
    const findings = findingsFor(traces);
    expect(findings).toContainEqual(expect.objectContaining({ id: 'too-many-turns:helper:run_0050', kind: 'too-many-turns', evidence: expect.objectContaining({ turns: 8, toolCallsPerTurn: 1 }) }));
    expect(findings).toContainEqual(expect.objectContaining({ id: 'high-retry-rate:helper:helper', kind: 'high-retry-rate', evidence: expect.objectContaining({ retries: 6, turns: 24, retriesPerTurn: 0.25 }) }));
    expect(findings).toContainEqual(expect.objectContaining({ id: 'claimed-success-user-incorrect:helper:run_0052', severity: 'bad' }));
  });

  it('flags runs far slower or more expensive than the agent\'s median', () => {
    const findings = findingsFor([fixtureTrace({ run: { startedAt: 50, durationMs: 10_000, inputTokens: 20_000 } })]);
    expect(findings).toContainEqual(expect.objectContaining({ id: 'slow-run:helper:run_0050', label: 'slow', evidence: expect.objectContaining({ durationMs: 10_000, agentMedianDurationMs: 1_000 }) }));
    expect(findings).toContainEqual(expect.objectContaining({ id: 'expensive-run:helper:run_0050', evidence: expect.objectContaining({ tokens: 20_000, agentMedianTokens: 1_000 }) }));
  });

  it('uses cost for expensive runs when pricing is known', () => {
    const traces = [...cleanTraces(), fixtureTrace({ run: { startedAt: 50, outputTokens: 1_000 } })];
    const findings = findFindings({ traces, minRuns: MIN_RUNS, pricing: { 'fake:m': { inputPerMTokUsd: 1, outputPerMTokUsd: 100 } } });
    expect(findings).toContainEqual(expect.objectContaining({ id: 'expensive-run:helper:run_0050', evidence: expect.objectContaining({ costUsd: 0.101, agentMedianCostUsd: 0.001 }) }));
  });

  it('needs minRuns runs before calling a run slow or expensive', () => {
    const findings = findFindings({ traces: [...cleanTraces(3), fixtureTrace({ run: { startedAt: 50, durationMs: 10_000 } })], minRuns: MIN_RUNS });
    expect(findings.map(({ kind }) => kind)).not.toContain('slow-run');
  });

  it('flags tools whose results are often truncated', () => {
    const truncating = fixtureTrace({ run: { startedAt: 50 }, steps: [true, true, false, false].map((truncated, turn) => ({ tool: 'big', truncated, turn })) });
    expect(findingsFor([truncating])).toContainEqual(expect.objectContaining({ id: 'truncation-frequent:helper:big', severity: 'info', evidence: expect.objectContaining({ truncated: 2, calls: 4 }) }));
  });

  it('orders by severity then id, whatever the input order (property)', () => {
    const traces = [
      ...cleanTraces(),
      fixtureTrace({ run: { startedAt: 50, durationMs: 10_000, userVerdict: 'incorrect', claimedSuccess: 1, turns: 9, toolCalls: 9 }, steps: [1, 2, 3].map(turn => ({ tool: 'big', truncated: true, ok: false, errorCategory: 'thrown', turn })) }),
      fixtureTrace({ run: { startedAt: 51, agentName: 'other', retries: 5 } }),
    ];
    const expected = findFindings({ traces, minRuns: MIN_RUNS });
    const severities = expected.map(({ severity }) => ['bad', 'warn', 'info'].indexOf(severity));
    expect([...severities].sort((left, right) => left - right)).toEqual(severities);
    fc.assert(fc.property(fc.shuffledSubarray(traces, { minLength: traces.length, maxLength: traces.length }), shuffled => {
      expect(findFindings({ traces: shuffled, minRuns: MIN_RUNS })).toEqual(expected);
    }), { numRuns: 30 });
  });
});
