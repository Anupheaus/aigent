import type { RunRecord } from '../telemetry/run-record.js';
import { compareRunOrder } from './baseline.js';
import { makeFinding } from './finding-rules.js';
import { costOfRun } from './pricing.js';
import type { Finding, Pricing } from './report-types.js';
import { weightedTokens } from './run-metrics.js';
import { median, roundRate, roundUsd } from './stats.js';

/** Runs with at least this many turns... */
const MANY_TURNS = 5;
/** ...and at most this many tool calls per turn spend their turns on too little work. */
const FEW_CALLS_PER_TURN = 1.5;
/** Provider retries per turn above which retries are worth a look. */
const HIGH_RETRIES_PER_TURN = 0.2;
/** A run this many times the agent's median duration or cost is an outlier. */
const OUTLIER_FACTOR = 3;

export interface RunFindingsParams {
  agentName: string;
  /** The agent's runs in the report. */
  runs: RunRecord[];
  minRuns: number;
  pricing?: Pricing;
}

function tooManyTurns(params: RunFindingsParams): Finding[] {
  const { agentName, runs } = params;
  return runs.filter(({ usage: { turns, toolCallsPerTurn } }) => turns >= MANY_TURNS && toolCallsPerTurn <= FEW_CALLS_PER_TURN).map(({ runId, usage: { turns, toolCallsPerTurn } }) => makeFinding({
    kind: 'too-many-turns', severity: 'warn', label: 'inefficient', agentName, subject: runId,
    message: `Run '${runId}' took ${turns} turns at ${toolCallsPerTurn} tool calls per turn; batch tools or aigent_multi would need fewer turns`,
    evidence: { turns, toolCallsPerTurn },
  }));
}

function highRetryRate(params: RunFindingsParams): Finding[] {
  const { agentName, runs } = params;
  const retries = runs.reduce((total, { usage }) => total + usage.retries, 0);
  const turns = runs.reduce((total, { usage }) => total + usage.turns, 0);
  if (turns === 0 || retries / turns < HIGH_RETRIES_PER_TURN) return [];
  const retriesPerTurn = roundRate(retries / turns);
  return [makeFinding({
    kind: 'high-retry-rate', severity: 'warn', label: 'inefficient', agentName, subject: agentName,
    message: `Agent '${agentName}' retried ${retries} provider calls over ${turns} turns; check rate limits and provider health`,
    evidence: { retries, turns, retriesPerTurn },
  })];
}

function claimedSuccessUserIncorrect(params: RunFindingsParams): Finding[] {
  const { agentName, runs } = params;
  return runs.filter(({ userVerdict, outcomeSummary }) => userVerdict === 'incorrect' && outcomeSummary.claimedSuccess > 0).map(({ runId, outcomeSummary }) => makeFinding({
    kind: 'claimed-success-user-incorrect', severity: 'bad', label: 'inefficient', agentName, subject: runId,
    message: `Run '${runId}' reported success ${outcomeSummary.claimedSuccess} times but the user rated its answer incorrect`,
    evidence: { claimedSuccess: outcomeSummary.claimedSuccess, userVerdict: 'incorrect' },
  }));
}

function slowRuns(params: RunFindingsParams): Finding[] {
  const { agentName, runs } = params;
  const agentMedianDurationMs = median(runs.map(({ timings }) => timings.durationMs)) ?? 0;
  return runs.filter(({ timings }) => agentMedianDurationMs > 0 && timings.durationMs >= OUTLIER_FACTOR * agentMedianDurationMs).map(({ runId, timings: { durationMs } }) => makeFinding({
    kind: 'slow-run', severity: 'warn', label: 'slow', agentName, subject: runId,
    message: `Run '${runId}' took ${durationMs} ms, over ${OUTLIER_FACTOR} times the agent's median of ${agentMedianDurationMs} ms`,
    evidence: { durationMs, agentMedianDurationMs },
  }));
}

/** By cost when every run is priced, otherwise by tokens. */
function expensiveRuns(params: RunFindingsParams): Finding[] {
  const { agentName, runs, pricing } = params;
  const costs = runs.map(run => costOfRun({ run, ...(pricing == null ? {} : { pricing }) }));
  if (costs.every((cost): cost is number => cost != null)) {
    const agentMedianCostUsd = roundUsd(median(costs) ?? 0);
    return runs.flatMap((run, position) => {
      const costUsd = roundUsd(costs[position] ?? 0);
      if (agentMedianCostUsd <= 0 || costUsd < OUTLIER_FACTOR * agentMedianCostUsd) return [];
      return [makeFinding({
        kind: 'expensive-run', severity: 'warn', label: 'inefficient', agentName, subject: run.runId,
        message: `Run '${run.runId}' cost $${costUsd}, over ${OUTLIER_FACTOR} times the agent's median of $${agentMedianCostUsd}`,
        evidence: { costUsd, agentMedianCostUsd },
      })];
    });
  }
  const agentMedianTokens = median(runs.map(weightedTokens)) ?? 0;
  return runs.filter(run => agentMedianTokens > 0 && weightedTokens(run) >= OUTLIER_FACTOR * agentMedianTokens).map(run => makeFinding({
    kind: 'expensive-run', severity: 'warn', label: 'inefficient', agentName, subject: run.runId,
    message: `Run '${run.runId}' used ${weightedTokens(run)} tokens, over ${OUTLIER_FACTOR} times the agent's median of ${agentMedianTokens}`,
    evidence: { tokens: weightedTokens(run), agentMedianTokens },
  }));
}

/** Per-run and per-agent findings; outliers (slow, expensive) need `minRuns` runs to compare against. */
export function runFindings(params: RunFindingsParams): Finding[] {
  const runs = [...params.runs].sort(compareRunOrder);
  const sorted = { ...params, runs };
  const outliers = runs.length >= params.minRuns ? [...slowRuns(sorted), ...expensiveRuns(sorted)] : [];
  return [...tooManyTurns(sorted), ...highRetryRate(sorted), ...claimedSuccessUserIncorrect(sorted), ...outliers];
}
