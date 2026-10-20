import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixtureTrace } from '../scoring/fixtures.test-support.js';
import { directRun, flailingRun } from './analysis-fixtures.test-support.js';
import { mineSequences } from './sequence-mining.js';
import { suggestTools } from './tool-suggestions.js';

function suggestFor(traces: ReturnType<typeof flailingRun>[]) {
  return suggestTools(mineSequences(traces), traces);
}

describe('suggestTools', () => {
  it('proposes one tool for search -> read -> search -> read, with its arguments and saving per use', () => {
    expect(suggestFor([flailingRun(1), flailingRun(2), flailingRun(3), flailingRun(4)])).toEqual([{
      name: 'search_then_read',
      description: "One call that does what 'search -> read -> search -> read' did in 4 runs, returning the final result directly.",
      replaces: ['search -> read -> search -> read'],
      supportingRunIds: ['run_0001', 'run_0002', 'run_0003', 'run_0004'],
      proposedArgs: [{ name: 'query', type: 'string' }],
      // The intermediate results (50 + 20 + 50 tokens), three extra turns and the 3 s between the first call and the last.
      estimatedSaving: { tokensPerUse: 120, turnsPerUse: 3, timePerUseMs: 3_000 },
    }]);
  });

  it('merges sequences of the same tools into one suggestion, averaging the saving over every use', () => {
    const [suggestion] = suggestFor([flailingRun(1), flailingRun(2), flailingRun(3), directRun(4)]);
    expect(suggestion).toMatchObject({
      name: 'search_then_read',
      replaces: ['search -> read', 'search -> read -> search -> read'],
      supportingRunIds: ['run_0001', 'run_0002', 'run_0003', 'run_0004'],
    });
    // Seven uses: four of search -> read (50 tokens, 1 turn, 1,000 ms) and three of the long path (120, 3, 3,000).
    expect(suggestion?.estimatedSaving).toEqual({ tokensPerUse: 80, turnsPerUse: 1.9, timePerUseMs: 1_857 });
  });

  it('suggests nothing when no sequence reaches support', () => {
    expect(suggestFor([flailingRun(1), flailingRun(2)])).toEqual([]);
  });

  it('reads argument types from the shape summary when content was not captured', () => {
    const traces = [1, 2, 3].map(startedAt => fixtureTrace({ run: { startedAt }, steps: [
      { tool: 'find_files', turn: 1, argsSummary: '{"depth":"<number>","pattern":"<string>"}' },
      { tool: 'read', turn: 2, argsSummary: '{"path":"<string>"}', outcome: { success: true, answer: '', source: 'previous' } },
    ] }));
    expect(suggestFor(traces)[0]).toMatchObject({ name: 'find_files_then_read', proposedArgs: [{ name: 'depth', type: 'number' }, { name: 'pattern', type: 'string' }] });
  });

  it('does not depend on input order (property)', () => {
    const traces = [flailingRun(1), flailingRun(2), flailingRun(3), directRun(4), directRun(5)];
    const expected = suggestFor(traces);
    fc.assert(fc.property(fc.shuffledSubarray(traces, { minLength: traces.length, maxLength: traces.length }), shuffled => {
      expect(suggestTools(mineSequences(shuffled), shuffled)).toEqual(expected);
    }), { numRuns: 30 });
  });
});
