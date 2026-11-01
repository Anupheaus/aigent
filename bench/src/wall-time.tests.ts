import { describe, expect, it } from 'vitest';
import { CALIBRATION_BASELINE_MS, MAX_SLOWDOWN, measureSlowdown, slowdownFrom, wallTimeFindings, withSlowdown } from './wall-time.test-support.js';

describe('machine slowdown', () => {
  it('is the calibration time over the baseline, never below 1 and never above the cap', () => {
    expect(slowdownFrom({ measuredMs: CALIBRATION_BASELINE_MS / 2 })).toBe(1);
    expect(slowdownFrom({ measuredMs: CALIBRATION_BASELINE_MS * 3 })).toBe(3);
    expect(slowdownFrom({ measuredMs: CALIBRATION_BASELINE_MS * 1_000 })).toBe(MAX_SLOWDOWN);
  });

  it('is measured on this machine within those bounds', async () => {
    const slowdown = await measureSlowdown();
    expect(slowdown).toBeGreaterThanOrEqual(1);
    expect(slowdown).toBeLessThanOrEqual(MAX_SLOWDOWN);
  });

  it('rises while the event loop is held by other work', async () => {
    const held = setInterval(() => {
      const until = performance.now() + CALIBRATION_BASELINE_MS;
      while (performance.now() < until) { /* competing work on the same thread */ }
    }, 0);
    try {
      expect(await measureSlowdown()).toBeGreaterThan(1);
    } finally {
      clearInterval(held);
    }
  });

  it('takes the larger of the calibrations around a run', async () => {
    const { value, slowdown } = await withSlowdown(async () => 'done');
    expect(value).toBe('done');
    expect(slowdown).toBeGreaterThanOrEqual(1);
  });
});

describe('wall-time findings', () => {
  it('accept a time within the declared limit scaled by the slowdown, and name every number when over it', () => {
    expect(wallTimeFindings({ label: 'reference', ms: 150, maxMs: 100, slowdown: 1.5 })).toEqual([]);
    expect(wallTimeFindings({ label: 'reference', ms: 151, maxMs: 100, slowdown: 1.5 })).toEqual(['reference took 151 ms, over the declared 100 ms x machine slowdown 1.50 = 150 ms']);
  });
});
