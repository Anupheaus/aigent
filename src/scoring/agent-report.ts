import type { RunRecord } from '../telemetry/run-record.js';
import type { AgentReport, Pricing, RunMetrics } from './report-types.js';
import { runMetrics } from './run-metrics.js';
import { scoreRuns } from './score.js';
import { median, percentile, roundToTenth, roundUsd, sum } from './stats.js';

/** The p in p90. */
const P90_FRACTION = 0.9;

export interface BuildAgentReportParams {
  /** The report's runs of one agent version. */
  runs: RunRecord[];
  /** Every stored run of that version: the rolling baseline. */
  history: RunRecord[];
  minRuns: number;
  pricing?: Pricing;
}

type Summarise = (values: number[]) => number | null;

/** One figure per metric; cost is null unless every run was priced. */
function summariseMetrics(params: { metrics: RunMetrics[]; summarise: Summarise }): RunMetrics {
  const { metrics, summarise } = params;
  const pick = (read: (entry: RunMetrics) => number): number => roundToTenth(summarise(metrics.map(read)) ?? 0);
  const costs = metrics.map(({ costUsd }) => costUsd);
  const isPriced = costs.length > 0 && costs.every(cost => cost != null);
  const costUsd = isPriced ? summarise(costs as number[]) : null;
  return {
    durationMs: pick(({ durationMs }) => durationMs),
    tokens: pick(({ tokens }) => tokens),
    turns: pick(({ turns }) => turns),
    toolCalls: pick(({ toolCalls }) => toolCalls),
    toolCallsPerTurn: pick(({ toolCallsPerTurn }) => toolCallsPerTurn),
    costUsd: costUsd == null ? null : roundUsd(costUsd),
  };
}

/** Scores, totals, medians and p90s for one agent version. */
export function buildAgentReport(params: BuildAgentReportParams): AgentReport {
  const { runs, history, minRuns, pricing } = params;
  const [first] = runs;
  const metrics = runs.map(run => runMetrics({ run, ...(pricing == null ? {} : { pricing }) }));
  const totals = summariseMetrics({ metrics, summarise: values => sum(values) });
  return {
    agentName: first?.agentName ?? '',
    agentVersion: first?.agentVersion ?? '',
    runs: runs.length,
    scores: scoreRuns({ runs, baseline: history, minRuns, ...(pricing == null ? {} : { pricing }) }),
    totals: { tokens: totals.tokens, costUsd: totals.costUsd, durationMs: totals.durationMs, turns: totals.turns, toolCalls: totals.toolCalls },
    medians: summariseMetrics({ metrics, summarise: median }),
    p90s: summariseMetrics({ metrics, summarise: values => percentile({ values, fraction: P90_FRACTION }) }),
  };
}
