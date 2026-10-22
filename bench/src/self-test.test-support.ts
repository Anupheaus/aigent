import { benchError } from './bench-error.js';
import type { RunRow } from './harness/run-task.js';
import { runTask } from './harness/run-task.js';
import { scriptedSolver } from './solvers/registry.js';
import { CATALOGUE } from './tasks/catalogue.js';
import { readSpecs } from './tasks/spec-files.js';
import type { TaskSpec } from './task-spec.js';

/** The share of tasks on which the naive policy must pass, but not reach target. */
export const NAIVE_PASS_SHARE = 0.8;
const SOLVERS = ['reference', 'naive', 'decoy', 'lazy'].map(scriptedSolver);

export interface SelfTestRows {
  reference: RunRow;
  naive: RunRow;
  decoy: RunRow;
  lazy: RunRow;
}

/** Runs the four self-test solvers on a spec. */
export async function selfTest(spec: TaskSpec): Promise<SelfTestRows> {
  const [reference, naive, decoy, lazy] = await Promise.all(SOLVERS.map(solver => runTask({ spec, solver })));
  if (reference == null || naive == null || decoy == null || lazy == null) throw benchError(`selfTest: a solver produced no row for '${spec.id}'`, { id: spec.id });
  return { reference, naive, decoy, lazy };
}

/**
 * What is wrong with a spec's self-test: the reference must reproduce its committed measurement (tokens, turns, tool
 * calls) and be correct, and decoy and lazy must fail. Because the budgets derive from that same measurement, "the
 * reference reaches target" cannot fail on tokens, turns or calls; it checks correctness, determinism and the wall
 * time against the declared per-size time, the only budget not derived from the reference run.
 */
export function selfTestFindings(params: { spec: TaskSpec; rows: SelfTestRows }): string[] {
  const { spec, rows: { reference, decoy, lazy } } = params;
  const { measured } = spec.reference;
  return [
    ...(reference.tier === 'target' || reference.tier === 'stretch' ? [] : [`reference reached ${reference.tier} (${reference.failures.join('; ')})`]),
    ...(reference.tokens === measured.tokens && reference.turns === measured.turns && reference.toolCalls === measured.toolCalls ? [] : [`reference measured ${reference.tokens}/${reference.turns}/${reference.toolCalls}, committed ${measured.tokens}/${measured.turns}/${measured.toolCalls}`]),
    ...(decoy.correct ? ['the decoy-falling policy was correct'] : []),
    ...(lazy.correct ? ['the lazy policy was correct'] : []),
  ];
}

/** Whether the naive policy passed but poorly (pass tier, not target). */
export const naivePassedPoorly = (rows: SelfTestRows): boolean => rows.naive.tier === 'pass';

/** The committed, non-held-out specs of the catalogue tasks in `half` (0: the first half of the catalogue, 1: the rest). */
export async function selfTestSpecs(half: 0 | 1): Promise<TaskSpec[]> {
  const middle = Math.ceil(CATALOGUE.length / 2);
  const tasks = new Set(CATALOGUE.slice(half === 0 ? 0 : middle, half === 0 ? middle : undefined).map(({ id }) => id));
  return (await readSpecs()).filter(spec => !spec.heldOut && tasks.has(spec.family));
}
