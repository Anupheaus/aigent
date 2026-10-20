import type { RunRecord } from '../telemetry/run-record.js';
import { isVersion } from './report-filter.js';
import type { ComparisonMetrics, Pricing, VersionComparison, VersionSide } from './report-types.js';
import { isCompletedAndNotRejected, runMetrics } from './run-metrics.js';
import { median, roundToTenth, roundUsd } from './stats.js';

export interface CompareVersionsParams {
  /** Runs matching the report's other filters. */
  runs: RunRecord[];
  versions: [string, string];
  pricing?: Pricing;
}

const PERCENT = 100;
const METRIC_KEYS = ['durationMs', 'tokens', 'turns', 'toolCallsPerTurn', 'costUsd', 'reliability'] as const;

function medianOrNull(values: (number | null)[]): number | null {
  return median(values.filter((value): value is number => value != null));
}

function sideOf(params: { runs: RunRecord[]; version: string; pricing?: Pricing }): VersionSide {
  const { runs, version, pricing } = params;
  const matching = runs.filter(run => isVersion({ run, version }));
  const metrics = matching.map(run => runMetrics({ run, ...(pricing == null ? {} : { pricing }) }));
  const cost = medianOrNull(metrics.map(({ costUsd }) => costUsd));
  const reliable = matching.filter(isCompletedAndNotRejected).length;
  return {
    version,
    runs: matching.length,
    medians: {
      durationMs: medianOrNull(metrics.map(({ durationMs }) => durationMs)),
      tokens: medianOrNull(metrics.map(({ tokens }) => tokens)),
      turns: medianOrNull(metrics.map(({ turns }) => turns)),
      toolCallsPerTurn: medianOrNull(metrics.map(({ toolCallsPerTurn }) => toolCallsPerTurn)),
      costUsd: cost == null ? null : roundUsd(cost),
      reliability: matching.length === 0 ? null : roundToTenth((reliable / matching.length) * PERCENT),
    },
  };
}

function deltaOf(params: { key: typeof METRIC_KEYS[number]; before: ComparisonMetrics; after: ComparisonMetrics }): number | null {
  const { key, before, after } = params;
  const beforeValue = before[key];
  const afterValue = after[key];
  if (beforeValue == null || afterValue == null) return null;
  // Cost differences are tiny fractions of a dollar, so they keep their own precision.
  return key === 'costUsd' ? roundUsd(afterValue - beforeValue) : roundToTenth(afterValue - beforeValue);
}

/** Before/after medians for two versions (hash or label) and their differences (after minus before). */
export function compareVersions(params: CompareVersionsParams): VersionComparison {
  const { runs, versions: [beforeVersion, afterVersion], pricing } = params;
  const before = sideOf({ runs, version: beforeVersion, ...(pricing == null ? {} : { pricing }) });
  const after = sideOf({ runs, version: afterVersion, ...(pricing == null ? {} : { pricing }) });
  const deltas = Object.fromEntries(METRIC_KEYS.map(key => [key, deltaOf({ key, before: before.medians, after: after.medians })])) as unknown as ComparisonMetrics;
  return { before, after, deltas };
}
