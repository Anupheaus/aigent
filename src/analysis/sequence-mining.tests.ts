import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixtureTrace } from '../scoring/fixtures.test-support.js';
import { directRun, flailingRun } from './analysis-fixtures.test-support.js';
import { mineSequences } from './sequence-mining.js';

const SUCCESS = { success: true, answer: 'done', source: 'directive' } as const;

describe('mineSequences', () => {
  it('finds the recurring path that ends in success, counting distinct runs and keeping only the longest form', () => {
    const traces = [flailingRun(1), flailingRun(2), flailingRun(3), flailingRun(4)];
    expect(mineSequences(traces)).toEqual([{
      tools: ['search', 'read', 'search', 'read'], support: 4, runIds: ['run_0001', 'run_0002', 'run_0003', 'run_0004'],
      occurrences: [1, 2, 3, 4].map(runNumber => ({ runId: `run_000${runNumber}`, startIndex: 0, endIndex: 3 })),
    }]);
  });

  it('keeps a shorter sequence that more runs share', () => {
    const traces = [flailingRun(1), flailingRun(2), flailingRun(3), directRun(4)];
    expect(mineSequences(traces).map(({ tools, support }) => [tools.join(' -> '), support])).toEqual([
      ['search -> read', 4],
      ['search -> read -> search -> read', 3],
    ]);
  });

  it('reports nothing below minSupport, and honours custom lengths and support', () => {
    expect(mineSequences([flailingRun(1), flailingRun(2)])).toEqual([]);
    expect(mineSequences([flailingRun(1), flailingRun(2)], { minLength: 2, maxLength: 2, minSupport: 2 }).map(({ tools }) => tools)).toEqual([['search', 'read']]);
  });

  it('ignores sequences wholly inside one aigent_multi batch, but not ones that end in it', () => {
    const insideBatch = [1, 2, 3].map(startedAt => fixtureTrace({ run: { startedAt }, steps: [
      { tool: 'aigent_multi', outcome: SUCCESS },
      { tool: 'search', parentCallId: 'c0' },
      { tool: 'read', parentCallId: 'c0' },
    ] }));
    expect(mineSequences(insideBatch)).toEqual([]);
    const endingInBatch = [1, 2, 3].map(startedAt => fixtureTrace({ run: { startedAt }, steps: [
      { tool: 'search', turn: 1 },
      { tool: 'aigent_multi', turn: 2, outcome: SUCCESS },
      { tool: 'read', turn: 2, parentCallId: 'c1' },
    ] }));
    expect(mineSequences(endingInBatch).map(({ tools }) => tools)).toEqual([['search', 'read']]);
  });

  it('never seeds from runs the user rated incorrect', () => {
    const traces = [flailingRun(1), flailingRun(2), flailingRun(3, { userVerdict: 'incorrect' })];
    expect(mineSequences(traces)).toEqual([]);
  });

  it('does not depend on input order (property)', () => {
    const traces = [flailingRun(1), flailingRun(2), flailingRun(3), directRun(4), directRun(5), directRun(6)];
    const expected = mineSequences(traces);
    fc.assert(fc.property(fc.shuffledSubarray(traces, { minLength: traces.length, maxLength: traces.length }), shuffled => {
      expect(mineSequences(shuffled)).toEqual(expected);
    }), { numRuns: 30 });
  });
});
