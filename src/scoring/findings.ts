import type { RunTrace } from '../telemetry/run-record.js';
import { compareFindings, groupSorted } from './finding-rules.js';
import type { Finding, Pricing } from './report-types.js';
import { runFindings } from './run-findings.js';
import { shaperFindings } from './shaper-findings.js';
import { toolFindings } from './tool-findings.js';

export interface FindFindingsParams {
  /** The report's runs with their steps (steps may be empty when a trace was not stored). */
  traces: RunTrace[];
  minRuns: number;
  pricing?: Pricing;
}

/**
 * Heuristic findings per agent: slow, failing, verbose, truncated and unbatched tools; runs with too many turns,
 * outlier duration or cost, retries, and success claims the user rejected. A `guardrail` kind is reserved for the
 * guardrails slice. Pure, and ordered by severity then id.
 */
export function findFindings(params: FindFindingsParams): Finding[] {
  const { traces, minRuns, pricing } = params;
  const findings = groupSorted({ items: traces, keyOf: ({ run }) => run.agentName }).flatMap(([agentName, agentTraces]) => [
    ...toolFindings({ agentName, traces: agentTraces }),
    ...shaperFindings({ agentName, traces: agentTraces }),
    ...runFindings({ agentName, runs: agentTraces.map(({ run }) => run), minRuns, ...(pricing == null ? {} : { pricing }) }),
  ]);
  return findings.sort(compareFindings);
}
