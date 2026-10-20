import { describe, expect, it } from 'vitest';
import { compareRunOrder, rollingBaselines } from './baseline.js';
import { fixtureRun, fixtureSeries } from './fixtures.test-support.js';

describe('rollingBaselines', () => {
  it('returns up to 50 runs that started before the run, most recent last', () => {
    const pool = fixtureSeries({ count: 60, firstStartedAt: 1 });
    const run = fixtureRun({ startedAt: 100 });
    const [baseline = []] = rollingBaselines({ runs: [run], pool: [...pool, run] });
    expect(baseline).toHaveLength(50);
    expect(baseline[0]?.timings.startedAt).toBe(11);
    expect(baseline.at(-1)?.timings.startedAt).toBe(60);
  });

  it('never includes the run itself or later runs, and orders start-time ties by run id', () => {
    const run = fixtureRun({ startedAt: 5, runId: 'b' });
    const pool = [fixtureRun({ startedAt: 6, runId: 'z' }), fixtureRun({ startedAt: 5, runId: 'c' }), run, fixtureRun({ startedAt: 5, runId: 'a' }), fixtureRun({ startedAt: 4, runId: 'y' })];
    expect(rollingBaselines({ runs: [run], pool })[0]?.map(({ runId }) => runId)).toEqual(['y', 'a']);
  });

  it('gives each run its own baseline, in the order the runs were given, whatever the pool order', () => {
    const pool = fixtureSeries({ count: 5, firstStartedAt: 1 }).reverse();
    const late = fixtureRun({ startedAt: 5 });
    const early = fixtureRun({ startedAt: 2 });
    const first = fixtureRun({ startedAt: 1 });
    expect(rollingBaselines({ runs: [late, early, first], pool }).map(baseline => baseline.map(({ timings }) => timings.startedAt))).toEqual([[1, 2, 3, 4], [1], []]);
  });
});

describe('compareRunOrder', () => {
  it('sorts by start time, then run id', () => {
    const runs = [fixtureRun({ startedAt: 2, runId: 'b' }), fixtureRun({ startedAt: 1, runId: 'z' }), fixtureRun({ startedAt: 2, runId: 'a' })];
    expect([...runs].sort(compareRunOrder).map(({ runId }) => runId)).toEqual(['z', 'a', 'b']);
  });
});
