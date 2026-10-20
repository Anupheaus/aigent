import type { RunRecord } from '../telemetry/run-record.js';

/** How many earlier runs of the same agent version a run is compared with. */
export const BASELINE_SIZE = 50;

/** Start time, then run id, so runs that started in the same millisecond still have one fixed order. */
export function compareRunOrder(left: RunRecord, right: RunRecord): number {
  const byStart = left.timings.startedAt - right.timings.startedAt;
  if (byStart !== 0) return byStart;
  return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
}

export interface RollingBaselineParams {
  run: RunRecord;
  /** Runs of the same agent version, in any order; the run itself may be among them. */
  pool: RunRecord[];
}

/** The up to `BASELINE_SIZE` runs that came just before `run`, oldest first. */
export function rollingBaseline(params: RollingBaselineParams): RunRecord[] {
  const { run, pool } = params;
  const earlier = pool.filter(candidate => compareRunOrder(candidate, run) < 0).sort(compareRunOrder);
  return earlier.slice(-BASELINE_SIZE);
}
