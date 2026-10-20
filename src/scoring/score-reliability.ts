import type { RunRecord } from '../telemetry/run-record.js';
import type { Score } from './report-types.js';
import { median, roundToTenth } from './stats.js';

/** At or above this share of reliable runs (percent) the label is efficient. */
const RELIABLE_PERCENT = 90;
/** Below this share of reliable runs (percent) the label is inefficient. */
const UNRELIABLE_PERCENT = 70;
const PERCENT = 100;

export interface ReliabilityScoreParams {
  /** Sorted runs to score. */
  runs: RunRecord[];
  /** Each run's rolling baseline, by position. */
  baselines: RunRecord[][];
  minRuns: number;
}

/**
 * The user's verdict decides when there is one: `incorrect` is never reliable and `correct` always is, whatever the
 * agent claimed. Otherwise a run is reliable when it completed with no more tool failures than its baseline's median.
 */
function isReliable(params: { run: RunRecord; baseline: RunRecord[] }): boolean {
  const { run: { userVerdict, status, failureCount }, baseline } = params;
  if (userVerdict === 'incorrect') return false;
  if (userVerdict === 'correct') return true;
  const usualFailures = median(baseline.map(run => run.failureCount)) ?? 0;
  return status === 'completed' && failureCount <= usualFailures;
}

/** Percentage of scored runs that were reliable (see `isReliable`). */
export function reliabilityScore(params: ReliabilityScoreParams): Score {
  const { runs, baselines, minRuns } = params;
  const verdicts = runs.flatMap((run, position) => {
    const baseline = baselines[position] ?? [];
    return baseline.length < minRuns ? [] : [isReliable({ run, baseline })];
  });
  if (verdicts.length === 0) {
    return { value: null, label: 'insufficient-data', evidence: `No run had the ${minRuns} earlier runs of this version a score needs (0 of ${runs.length} scored)` };
  }
  const reliable = verdicts.filter(Boolean).length;
  const value = roundToTenth((reliable / verdicts.length) * PERCENT);
  const label = value >= RELIABLE_PERCENT ? 'efficient' : value < UNRELIABLE_PERCENT ? 'inefficient' : 'average';
  return { value, label, evidence: `${reliable} of ${verdicts.length} scored runs were reliable (completed, no more tool failures than the baseline median, not rated incorrect)` };
}
