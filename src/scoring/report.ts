import type { RunRecord, RunTrace } from '../telemetry/run-record.js';
import { buildAgentReport } from './agent-report.js';
import { compareVersions } from './compare-versions.js';
import { groupSorted } from './finding-rules.js';
import { findFindings } from './findings.js';
import { matchesFilter, parseReportFilter } from './report-filter.js';
import type { CacheFindings, Pricing, Report, ReportFilter } from './report-types.js';
import { DEFAULT_MIN_RUNS } from './score.js';

export interface BuildReportParams {
  /** Every stored run with its steps; the filter picks the report's runs, the rest still serve as baselines. */
  traces: RunTrace[];
  /** Validated here (it comes from the consumer); `undefined` means no filter. */
  filter: ReportFilter | undefined;
  generatedAt: number;
  pricing?: Pricing;
}

/** Placeholder until the tool-result cache slice records cache statistics. */
function emptyCacheFindings(): CacheFindings {
  return { hottestEntries: [], hitRates: [], deterministicCandidates: [], frequentInvalidations: [] };
}

/** Agent name and version, the grouping for scores and baselines. */
function versionKey(run: RunRecord): string {
  const { agentName, agentVersion } = run;
  return `${agentName}\n${agentVersion}`;
}

/** Turns stored runs and traces into scores, findings and an optional version comparison. Pure. */
export function buildReport(params: BuildReportParams): Report {
  const { traces, generatedAt, pricing } = params;
  const filter = parseReportFilter(params.filter);
  const { minRuns = DEFAULT_MIN_RUNS, compareVersions: versions } = filter;
  const selected = traces.filter(({ run }) => matchesFilter({ run, filter }));
  const histories = new Map(groupSorted({ items: traces.map(({ run }) => run), keyOf: versionKey }));
  const agents = groupSorted({ items: selected.map(({ run }) => run), keyOf: versionKey }).map(([key, runs]) => buildAgentReport({
    runs, history: histories.get(key) ?? runs, minRuns, ...(pricing == null ? {} : { pricing }),
  }));
  // compareVersions picks its own versions, so it sees the runs matching every other filter field.
  const comparisonRuns = traces.map(({ run }) => run).filter(run => matchesFilter({ run, filter: { ...filter, agentVersion: undefined } }));
  return {
    generatedAt,
    filter,
    runCount: selected.length,
    agents,
    findings: findFindings({ traces: selected, minRuns, ...(pricing == null ? {} : { pricing }) }),
    requests: [],
    toolSuggestions: [],
    cache: emptyCacheFindings(),
    ...(versions == null ? {} : { comparison: compareVersions({ runs: comparisonRuns, versions, ...(pricing == null ? {} : { pricing }) }) }),
  };
}
