import { describe, expect, it } from 'vitest';
import { compareRunOrder, rollingBaseline } from './baseline.js';
import { fixtureRun, fixtureSeries } from './fixtures.test-support.js';

describe('rollingBaseline', () => {
  it('returns up to 50 runs that started before the run, most recent last', () => {
    const pool = fixtureSeries({ count: 60, firstStartedAt: 1 });
    const run = fixtureRun({ startedAt: 100 });
    const baseline = rollingBaseline({ run, pool: [...pool, run] });
    expect(baseline).toHaveLength(50);
    expect(baseline[0]?.timings.startedAt).toBe(11);
    expect(baseline.at(-1)?.timings.startedAt).toBe(60);
  });

  it('never includes the run itself or later runs, and orders start-time ties by run id', () => {
    const run = fixtureRun({ startedAt: 5, runId: 'b' });
    const pool = [fixtureRun({ startedAt: 6, runId: 'z' }), fixtureRun({ startedAt: 5, runId: 'c' }), run, fixtureRun({ startedAt: 5, runId: 'a' }), fixtureRun({ startedAt: 4, runId: 'y' })];
    expect(rollingBaseline({ run, pool }).map(({ runId }) => runId)).toEqual(['y', 'a']);
  });
});

describe('compareRunOrder', () => {
  it('sorts by start time, then run id', () => {
    const runs = [fixtureRun({ startedAt: 2, runId: 'b' }), fixtureRun({ startedAt: 1, runId: 'z' }), fixtureRun({ startedAt: 2, runId: 'a' })];
    expect([...runs].sort(compareRunOrder).map(({ runId }) => runId)).toEqual(['z', 'a', 'b']);
  });
});
