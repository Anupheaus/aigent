import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixtureTrace } from '../scoring/fixtures.test-support.js';
import { groupSimilarTasks, normaliseTask } from './trace-group.js';

function taskTrace(startedAt: number, task?: string, label?: string) {
  return fixtureTrace({ run: { startedAt, ...(task == null ? {} : { task }), ...(label == null ? {} : { label }) } });
}

function groupedRunIds(groups: ReturnType<typeof groupSimilarTasks>): string[][] {
  return groups.map(({ traces }) => traces.map(({ run }) => run.runId));
}

describe('normaliseTask', () => {
  it('lowercases, strips punctuation and stopwords, and turns numbers into #', () => {
    expect(normaliseTask('Summarise issue #123, then the PR 45!')).toEqual(['summarise', 'issue', '#', 'then', 'pr']);
  });
});

describe('groupSimilarTasks', () => {
  it.each([
    ['Find the file that defines ThemeProvider', 'Find which file defines the ThemeProvider', true],
    ['Summarise issue 123', 'Summarise issue 4567', true],
    ['Find the file that defines ThemeProvider', 'Deploy the staging server', false],
    ['Rename the variable count to total', 'Rename the function count to total in utils', false],
  ])('%j and %j group together: %s', (first, second, together) => {
    const groups = groupSimilarTasks([taskTrace(1, first), taskTrace(2, second)]);
    expect(groups).toHaveLength(together ? 1 : 2);
  });

  it('orders groups and their runs by start, and samples the first task', () => {
    const groups = groupSimilarTasks([taskTrace(3, 'Deploy the staging server'), taskTrace(2, 'Summarise issue 9'), taskTrace(1, 'Summarise issue 8')]);
    expect(groupedRunIds(groups)).toEqual([['run_0001', 'run_0002'], ['run_0003']]);
    expect(groups[0]?.sampleTask).toBe('Summarise issue 8');
    expect(groups[0]?.groupId).toMatch(/^task:[0-9a-f]{12}$/);
  });

  it('groups runs without task text by label, else alone', () => {
    const groups = groupSimilarTasks([taskTrace(1, undefined, 'nightly'), taskTrace(2), taskTrace(3, undefined, 'nightly')]);
    expect(groups.map(({ groupId, sampleTask }) => ({ groupId, sampleTask }))).toEqual([
      { groupId: 'label:nightly', sampleTask: 'nightly' },
      { groupId: 'run:run_0002', sampleTask: '' },
    ]);
    expect(groupedRunIds(groups)).toEqual([['run_0001', 'run_0003'], ['run_0002']]);
  });

  it('honours a custom threshold', () => {
    // Three shared words out of six distinct ones: a Jaccard similarity of 0.5.
    const traces = [taskTrace(1, 'alpha beta gamma delta epsilon'), taskTrace(2, 'alpha beta gamma omega')];
    expect(groupSimilarTasks(traces)).toHaveLength(2);
    expect(groupSimilarTasks(traces, { threshold: 0.5 })).toHaveLength(1);
  });

  it('does not depend on input order (property)', () => {
    const tasks = ['Summarise issue 1', 'Summarise issue 22', 'Deploy staging', 'Deploy staging now', 'Find the theme file', 'Find theme file please'];
    const traces = tasks.map((task, position) => taskTrace(position + 1, task));
    const expected = groupSimilarTasks(traces);
    fc.assert(fc.property(fc.shuffledSubarray(traces, { minLength: traces.length, maxLength: traces.length }), shuffled => {
      expect(groupSimilarTasks(shuffled)).toEqual(expected);
    }), { numRuns: 30 });
  });
});
