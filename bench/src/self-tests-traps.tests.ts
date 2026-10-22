import { describe, expect, it } from 'vitest';
import { naivePassedPoorly, NAIVE_PASS_SHARE, selfTest, selfTestFindings, selfTestSpecs } from './self-test.test-support.js';
import type { SelfTestRows } from './self-test.test-support.js';

const specs = await selfTestSpecs(1);
const results = new Map<string, SelfTestRows>();

describe('self-tests (second half of the catalogue, with the behavioural traps)', () => {
  it.each(specs.map(spec => [spec.id, spec] as const))('%s: reference reproduces its measurement within the declared time, decoy-falling and lazy fail', async (_id, spec) => {
    const rows = await selfTest(spec);
    results.set(spec.id, rows);
    expect(selfTestFindings({ spec, rows })).toEqual([]);
  }, 60_000);

  it(`the naive policy passes but misses target on at least ${NAIVE_PASS_SHARE * 100}% of tasks`, () => {
    const poorly = [...results.values()].filter(naivePassedPoorly).length;
    expect(poorly / results.size).toBeGreaterThanOrEqual(NAIVE_PASS_SHARE);
  });
});
