import { benchError } from './bench-error.js';
import type { RunRow } from './harness/run-task.js';
import { runTask } from './harness/run-task.js';
import { scriptedSolver } from './solvers/registry.js';
import type { Solver } from './solvers/solver-types.js';
import { CATALOGUE } from './tasks/catalogue.js';
import { readSpecs } from './tasks/spec-files.js';
import type { TaskSpec } from './task-spec.js';
import { isWithinWallTime, wallTimeFindings, withSlowdown } from './wall-time.test-support.js';

/** The share of tasks on which the naive policy must pass, but not reach target. */
export const NAIVE_PASS_SHARE = 0.8;
/** Per self-test case: four solvers one after another (with calibrations), with room for a slow, loaded machine. */
export const SELF_TEST_TIMEOUT_MS = 180_000;
const ROLES = ['reference', 'naive', 'decoy', 'lazy'] as const;
type SolverRole = typeof ROLES[number];

export interface SelfTestRows {
  reference: RunRow;
  naive: RunRow;
  decoy: RunRow;
  lazy: RunRow;
  /** The spec's pass-tier wall time, which the naive policy is held to. */
  passMaxMs: number;
  /** The machine's slowdown measured around each solver's run (see `withSlowdown`). */
  slowdowns: Record<SolverRole, number>;
}

/** Solvers that replace the scripted ones for a role (tests of the self-test itself). */
export type SelfTestSolvers = Partial<Record<SolverRole, Solver>>;

/**
 * Runs the four self-test solvers on a spec, one after another: run together they share one event loop, and each
 * one's wall time would include the others' work.
 */
export async function selfTest(spec: TaskSpec, solvers: SelfTestSolvers = {}): Promise<SelfTestRows> {
  const rows: Partial<Record<SolverRole, RunRow>> = {};
  const slowdowns: Partial<Record<SolverRole, number>> = {};
  for (const role of ROLES) {
    const solver = solvers[role] ?? scriptedSolver(role);
    const { value, slowdown } = await withSlowdown(() => runTask({ spec, solver }));
    rows[role] = value;
    slowdowns[role] = slowdown;
  }
  const { reference, naive, decoy, lazy } = rows;
  if (reference == null || naive == null || decoy == null || lazy == null) throw benchError(`selfTest: a solver produced no row for '${spec.id}'`, { id: spec.id });
  return { reference, naive, decoy, lazy, passMaxMs: spec.budgets.pass.maxMs, slowdowns: { reference: slowdowns.reference ?? 1, naive: slowdowns.naive ?? 1, decoy: slowdowns.decoy ?? 1, lazy: slowdowns.lazy ?? 1 } };
}

/**
 * What is wrong with a spec's self-test: the reference must reproduce its committed measurement (tokens, turns, tool
 * calls) exactly, be correct and within target on those counts, and finish within the declared target time scaled by
 * the machine's measured slowdown (bounded, see `wall-time.test-support.ts`); decoy and lazy must fail. Because the
 * count budgets derive from that same measurement, "within target on counts" checks correctness and determinism;
 * wall time is the only budget not derived from the reference run.
 */
export function selfTestFindings(params: { spec: TaskSpec; rows: SelfTestRows }): string[] {
  const { spec, rows: { reference, decoy, lazy, slowdowns } } = params;
  const { measured } = spec.reference;
  return [
    ...(reference.countTier === 'target' || reference.countTier === 'stretch' ? [] : [`reference reached ${reference.countTier} (${reference.failures.join('; ')})`]),
    ...(reference.tokens === measured.tokens && reference.turns === measured.turns && reference.toolCalls === measured.toolCalls ? [] : [`reference measured ${reference.tokens}/${reference.turns}/${reference.toolCalls}, committed ${measured.tokens}/${measured.turns}/${measured.toolCalls}`]),
    ...wallTimeFindings({ label: 'reference', ms: reference.ms, maxMs: spec.budgets.target.maxMs, slowdown: slowdowns.reference }),
    ...(decoy.correct ? ['the decoy-falling policy was correct'] : []),
    ...(lazy.correct ? ['the lazy policy was correct'] : []),
  ];
}

/** Whether the naive policy passed but poorly: the pass tier on counts (not target), within the pass time on this machine. */
export function naivePassedPoorly(rows: SelfTestRows): boolean {
  const { naive, passMaxMs, slowdowns } = rows;
  return naive.countTier === 'pass' && isWithinWallTime({ ms: naive.ms, maxMs: passMaxMs, slowdown: slowdowns.naive });
}

/** The committed, non-held-out specs of the catalogue tasks in `half` (0: the first half of the catalogue, 1: the rest). */
export async function selfTestSpecs(half: 0 | 1): Promise<TaskSpec[]> {
  const middle = Math.ceil(CATALOGUE.length / 2);
  const tasks = new Set(CATALOGUE.slice(half === 0 ? 0 : middle, half === 0 ? middle : undefined).map(({ id }) => id));
  return (await readSpecs()).filter(spec => !spec.heldOut && tasks.has(spec.family));
}
