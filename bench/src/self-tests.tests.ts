import { describe, expect, it } from 'vitest';
import { naivePassedPoorly, NAIVE_PASS_SHARE, SELF_TEST_TIMEOUT_MS, selfTest, selfTestFindings, selfTestSpecs } from './self-test.test-support.js';
import type { SelfTestRows } from './self-test.test-support.js';
import type { TaskSpec } from './task-spec.js';

const specs = await selfTestSpecs(0);
const results = new Map<string, SelfTestRows>();

describe('self-tests (first half of the catalogue)', () => {
  it.each(specs.map(spec => [spec.id, spec] as const))('%s: reference reproduces its measurement within the declared time, decoy-falling and lazy fail', async (_id, spec) => {
    const rows = await selfTest(spec);
    results.set(spec.id, rows);
    expect(selfTestFindings({ spec, rows })).toEqual([]);
  }, SELF_TEST_TIMEOUT_MS);

  it(`the naive policy passes but misses target on at least ${NAIVE_PASS_SHARE * 100}% of tasks`, () => {
    const poorly = [...results.values()].filter(naivePassedPoorly).length;
    expect(poorly / results.size).toBeGreaterThanOrEqual(NAIVE_PASS_SHARE);
  });

  it('breaks when the checker is broken: a decoy flipped into the truth fails the self-test', async () => {
    const spec = specs.find(({ groundTruth, decoys }) => groundTruth.kind === 'files' && decoys.some(({ path }) => path !== ''));
    expect(spec).toBeDefined();
    if (spec == null || spec.groundTruth.kind !== 'files') return;
    const decoy = spec.decoys.find(({ path }) => path !== '')?.path ?? '';
    const mutated: TaskSpec = { ...spec, groundTruth: { kind: 'files', files: [...spec.groundTruth.files, decoy] } };
    expect(selfTestFindings({ spec: mutated, rows: await selfTest(mutated) })).not.toEqual([]);
  }, SELF_TEST_TIMEOUT_MS);
});
