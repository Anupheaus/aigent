import type { TaskSpec } from '../task-spec.js';
import type { Solver } from '../solvers/solver-types.js';
import { runTask } from './run-task.js';
import type { RunRow } from './run-task.js';
import type { ToolSetBuilder } from './repo-tools.js';

/** One repetition's rows. */
export interface SuiteRun {
  repeat: number;
  rows: RunRow[];
}

/** Runs every solver on every spec, `repeat` times, in a fixed order (specs by id, then solvers as given). */
export async function runSuite(params: { specs: TaskSpec[]; solvers: Solver[]; repeat?: number; tools?: ToolSetBuilder; onRow?: (row: RunRow) => void }): Promise<SuiteRun[]> {
  const { specs, solvers, repeat = 1, tools, onRow } = params;
  const ordered = [...specs].sort((first, second) => first.id.localeCompare(second.id));
  const runs: SuiteRun[] = [];
  for (let round = 1; round <= repeat; round += 1) {
    const rows: RunRow[] = [];
    for (const spec of ordered) {
      for (const solver of solvers) {
        const row = await runTask({ spec, solver, ...(tools == null ? {} : { tools }) });
        rows.push(row);
        onRow?.(row);
      }
    }
    runs.push({ repeat: round, rows });
  }
  return runs;
}
