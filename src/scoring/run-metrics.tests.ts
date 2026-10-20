import { describe, expect, it } from 'vitest';
import { fixtureRun } from './fixtures.test-support.js';
import { isCompletedAndNotRejected, itemsPerCall, nonRepeatShare, runMetrics, weightedTokens } from './run-metrics.js';

describe('run metrics', () => {
  it('weights cached input at 0.1, never counting more cached tokens than input', () => {
    expect(weightedTokens(fixtureRun({ startedAt: 1, inputTokens: 1_000, cachedTokens: 600, outputTokens: 50 }))).toBe(400 + 60 + 50);
    expect(weightedTokens(fixtureRun({ startedAt: 1, inputTokens: 100, cachedTokens: 500 }))).toBe(10);
  });

  it('rates batching and repetition, and is null without tool calls', () => {
    const run = fixtureRun({ startedAt: 1, toolUse: { calls: 4, items: 10, repeats: 1 } });
    expect(itemsPerCall(run)).toBe(2.5);
    expect(nonRepeatShare(run)).toBe(0.75);
    const idle = fixtureRun({ startedAt: 1, toolCalls: 0 });
    expect(itemsPerCall(idle)).toBeNull();
    expect(nonRepeatShare(idle)).toBeNull();
  });

  it('collects the per-run figures, cost null without pricing', () => {
    expect(runMetrics({ run: fixtureRun({ startedAt: 1, durationMs: 300, turns: 3, toolCalls: 6 }) })).toEqual({ durationMs: 300, tokens: 1_000, turns: 3, toolCalls: 6, toolCallsPerTurn: 2, costUsd: null });
  });

  it.each([
    [{ status: 'completed' as const }, true],
    [{ status: 'failed' as const }, false],
    [{ status: 'failed' as const, userVerdict: 'correct' as const }, true],
    [{ status: 'completed' as const, userVerdict: 'incorrect' as const }, false],
    [{ status: 'completed' as const, userVerdict: 'partial' as const }, true],
  ])('treats %j as completed and not rejected: %s', (fields, expected) => {
    expect(isCompletedAndNotRejected(fixtureRun({ startedAt: 1, ...fields }))).toBe(expected);
  });
});
