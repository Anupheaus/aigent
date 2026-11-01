import { describe, expect, it } from 'vitest';
import type { UserFeedback } from '../feedback/feedback-records.js';
import { fixtureTrace } from '../scoring/fixtures.test-support.js';
import type { RunTrace } from '../telemetry/run-record.js';
import { buildGroupLessons } from './lessons.js';

function rated(params: { index: number; task: string; scopeKey: string; verdict?: 'incorrect' | 'correct' }): RunTrace {
  const { index, task, scopeKey, verdict = 'incorrect' } = params;
  const trace = fixtureTrace({ run: { startedAt: index, runId: `run_${index}`, task, userVerdict: verdict } });
  return { ...trace, run: { ...trace.run, memoryScopeKey: scopeKey } };
}

function ratingsFor(traces: RunTrace[], expectedAnswer: string): Map<string, UserFeedback> {
  return new Map(traces.map(({ run }) => [run.responseId, { responseId: run.responseId, rating: 'incorrect', expectedAnswer }]));
}

describe('buildGroupLessons', () => {
  it('makes one lesson per group of similar corrected tasks, quoting the expected answers', () => {
    const traces = [rated({ index: 1, task: 'how many moons does mars have', scopeKey: 'agent' }), rated({ index: 2, task: 'how many moons does mars have today', scopeKey: 'agent' })];
    const [lesson, ...rest] = buildGroupLessons({ traces, ratings: ratingsFor(traces, 'two') });
    expect(rest).toEqual([]);
    expect(lesson).toMatchObject({ scopeKey: 'agent', runIds: ['run_1', 'run_2'], note: { kind: 'lesson', text: 'Similar tasks ("how many moons does mars have") were answered incorrectly 2 times; users expected: two' } });
  });

  it('never mixes scopes, skips a task\'s own session scope and needs two corrections', () => {
    const split = [rated({ index: 1, task: 'how many moons does mars have', scopeKey: 'interface:a' }), rated({ index: 2, task: 'how many moons does mars have', scopeKey: 'interface:b' })];
    expect(buildGroupLessons({ traces: split, ratings: ratingsFor(split, 'two') })).toEqual([]);
    const sessions = [rated({ index: 1, task: 'how many moons does mars have', scopeKey: 'session:run_1' }), rated({ index: 2, task: 'how many moons does mars have', scopeKey: 'session:run_2' })];
    expect(buildGroupLessons({ traces: sessions, ratings: ratingsFor(sessions, 'two') })).toEqual([]);
    const correct = [rated({ index: 1, task: 'how many moons does mars have', scopeKey: 'agent' }), rated({ index: 2, task: 'how many moons does mars have', scopeKey: 'agent', verdict: 'correct' })];
    expect(buildGroupLessons({ traces: correct, ratings: ratingsFor(correct, 'two') })).toEqual([]);
  });

  it('needs an expected answer on every correction it counts', () => {
    const traces = [rated({ index: 1, task: 'how many moons does mars have', scopeKey: 'agent' }), rated({ index: 2, task: 'how many moons does mars have', scopeKey: 'agent' })];
    expect(buildGroupLessons({ traces, ratings: ratingsFor(traces, '  ') })).toEqual([]);
  });
});
