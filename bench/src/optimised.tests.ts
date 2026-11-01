import { describe, expect, it } from 'vitest';
import { quantile } from './harness/report.js';
import { runTask } from './harness/run-task.js';
import type { RunRow } from './harness/run-task.js';
import { toolSet } from './harness/tool-sets.js';
import { scriptedSolver } from './solvers/registry.js';
import { readSpecs } from './tasks/spec-files.js';
import { wallTimeFindings, withSlowdown } from './wall-time.test-support.js';

/** The margins recorded in `bench/results/round-3.md`: median tokens at least 10% below the reference, p90 turns lower. */
const MEDIAN_TOKEN_SAVING = 0.1;

const specs = (await readSpecs()).filter(({ heldOut }) => !heldOut);
const rows: RunRow[] = [];

describe('the optimised policy (Round 3 tools)', () => {
  it.each(specs.map(spec => [spec.id, spec] as const))('%s: correct, at target or better (counts exactly, wall time on this machine)', async (_id, spec) => {
    const { value: row, slowdown } = await withSlowdown(() => runTask({ spec, solver: scriptedSolver('optimised'), tools: toolSet('optimised') }));
    rows.push(row);
    expect(row.correct, row.failures.join('; ')).toBe(true);
    expect(['target', 'stretch']).toContain(row.countTier);
    expect(wallTimeFindings({ label: 'optimised', ms: row.ms, maxMs: spec.budgets.target.maxMs, slowdown })).toEqual([]);
  }, 60_000);

  it(`beats the reference on median tokens by at least ${MEDIAN_TOKEN_SAVING * 100}% and on p90 turns`, () => {
    const reference = specs.map(({ reference: { measured } }) => measured);
    expect(quantile(rows.map(({ tokens }) => tokens), 0.5)).toBeLessThanOrEqual(quantile(reference.map(({ tokens }) => tokens), 0.5) * (1 - MEDIAN_TOKEN_SAVING));
    expect(quantile(rows.map(({ turns }) => turns), 0.9)).toBeLessThan(quantile(reference.map(({ turns }) => turns), 0.9));
  });
});
