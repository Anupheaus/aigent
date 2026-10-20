import type { RunRecord } from '../telemetry/run-record.js';

/** How many earlier runs of the same agent version a run is compared with. */
export const BASELINE_SIZE = 50;

/** Start time, then run id, so runs that started in the same millisecond still have one fixed order. */
export function compareRunOrder(left: RunRecord, right: RunRecord): number {
  const byStart = left.timings.startedAt - right.timings.startedAt;
  if (byStart !== 0) return byStart;
  return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
}

export interface RollingBaselinesParams {
  /** The runs to find baselines for, in any order. */
  runs: RunRecord[];
  /** Runs of the same agent version, in any order; the runs themselves may be among them. */
  pool: RunRecord[];
}

/** Index of the first pool run that does not come before `run` (binary search over the sorted pool). */
function firstNotBefore(params: { sortedPool: RunRecord[]; run: RunRecord }): number {
  const { sortedPool, run } = params;
  let low = 0;
  let high = sortedPool.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareRunOrder(sortedPool[middle] as RunRecord, run) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * For each run (same order as `runs`), the up to `BASELINE_SIZE` pool runs that came just before it, oldest first.
 * The pool is sorted once and each baseline is a slice of it, so this stays O(n log n) on large stores.
 */
export function rollingBaselines(params: RollingBaselinesParams): RunRecord[][] {
  const { runs, pool } = params;
  const sortedPool = [...pool].sort(compareRunOrder);
  return runs.map(run => {
    const end = firstNotBefore({ sortedPool, run });
    return sortedPool.slice(Math.max(0, end - BASELINE_SIZE), end);
  });
}
