import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixtureTrace } from '../scoring/fixtures.test-support.js';
import { directRun, flailingRun } from './analysis-fixtures.test-support.js';
import { analyseRequest } from './request-efficiency.js';
import { groupSimilarTasks } from './trace-group.js';

function onlyGroup(traces: Parameters<typeof groupSimilarTasks>[0]) {
  const groups = groupSimilarTasks(traces);
  expect(groups).toHaveLength(1);
  return groups[0]!;
}

describe('analyseRequest', () => {
  it('finds the cheapest successful path, the typical cost, the saving and the wasted steps', () => {
    const traces = [flailingRun(1), flailingRun(2), flailingRun(3), flailingRun(4), directRun(5)];
    const analysis = analyseRequest(onlyGroup(traces));
    expect(analysis).toEqual({
      groupId: expect.stringMatching(/^task:/),
      sampleTask: 'Find the file that defines ThemeProvider',
      runs: 5,
      successfulRuns: 5,
      cheapestSuccessful: { runId: 'run_0005', tokens: 1_500, turns: 3, toolCalls: 2, durationMs: 1_500, path: ['search', 'read'] },
      typical: { medianTokens: 4_000, medianTurns: 5, medianToolCalls: 4 },
      wastedSteps: [1, 2, 3, 4].flatMap(runNumber => [
        { runId: `run_000${runNumber}`, stepIndex: 0, reason: 'superseded-search' },
        { runId: `run_000${runNumber}`, stepIndex: 1, reason: 'failed-before-success' },
      ]),
      potentialSaving: { tokens: 2_500, turns: 2 },
    });
  });

  it('never picks a run the user rated incorrect, however cheap', () => {
    const traces = [flailingRun(1), directRun(2, { userVerdict: 'incorrect', inputTokens: 10 })];
    const analysis = analyseRequest(onlyGroup(traces));
    expect(analysis.successfulRuns).toBe(1);
    expect(analysis.cheapestSuccessful?.runId).toBe('run_0001');
  });

  it('counts a run the user rated correct as successful even without an agent claim', () => {
    const quiet = fixtureTrace({ run: { startedAt: 1, task: 'Find the file that defines ThemeProvider', userVerdict: 'correct' }, steps: [{ tool: 'search' }] });
    expect(analyseRequest(onlyGroup([quiet])).successfulRuns).toBe(1);
  });

  it('has no cheapest path and no saving when nothing succeeded', () => {
    const failing = fixtureTrace({ run: { startedAt: 1, task: 'Find the file that defines ThemeProvider' }, steps: [{ tool: 'search', outcome: { success: false, answer: 'nothing', source: 'directive' } }] });
    const analysis = analyseRequest(onlyGroup([failing]));
    expect(analysis).not.toHaveProperty('cheapestSuccessful');
    expect(analysis.potentialSaving).toEqual({ tokens: 0, turns: 0 });
  });

  it('flags repeated calls and calls that could have been batched', () => {
    const run = fixtureTrace({ run: { startedAt: 1, task: 'Read the config files' }, steps: [
      { tool: 'read', turn: 1, argsSummary: '{"path":"a"}' },
      { tool: 'read', turn: 2, argsSummary: '{"path":"a"}' },
      { tool: 'read', turn: 3, argsSummary: '{"path":"b"}' },
      { tool: 'read', turn: 3, argsSummary: '{"path":"c"}', parentCallId: 'm1' },
    ] });
    expect(analyseRequest(onlyGroup([run])).wastedSteps).toEqual([
      { runId: 'run_0001', stepIndex: 1, reason: 'repeat-call' },
      { runId: 'run_0001', stepIndex: 2, reason: 'unbatched' },
    ]);
  });

  it('does not depend on the order of the group\'s runs (property)', () => {
    const traces = [flailingRun(1), flailingRun(2), directRun(3), directRun(4, { inputTokens: 1_500 })];
    const expected = analyseRequest(onlyGroup(traces));
    fc.assert(fc.property(fc.shuffledSubarray(traces, { minLength: traces.length, maxLength: traces.length }), shuffled => {
      expect(analyseRequest(onlyGroup(shuffled))).toEqual(expected);
    }), { numRuns: 30 });
  });
});
