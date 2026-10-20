import type { RunRecord } from '../telemetry/run-record.js';
import { makeFinding } from './finding-rules.js';
import type { Finding } from './report-types.js';
import { roundRate } from './stats.js';

/** A run needs at least this many compactions... */
const MIN_FREQUENT_COMPACTIONS = 2;
/** ...at more than this many per turn (one every five turns) to count as compacting too often. */
const FREQUENT_COMPACTIONS_PER_TURN = 0.2;
/** Success rates with and without compression are compared only with at least this many runs on each side. */
const MIN_RUNS_PER_SIDE = 3;
/**
 * Prefill time one saved input token is assumed to be worth. Compression that took longer than this per saved token
 * cost more time than it saved.
 */
const MS_PER_SAVED_TOKEN = 1;

/**
 * Runs that compacted their history so often that each compaction barely bought any turns: every compaction is a
 * prompt-cache miss and possibly a summariser call. Pure.
 */
function frequentCompaction(params: { agentName: string; runs: RunRecord[] }): Finding[] {
  const { agentName, runs } = params;
  return runs.filter(({ usage: { compactions = 0, turns } }) => compactions >= MIN_FREQUENT_COMPACTIONS && turns > 0 && compactions / turns > FREQUENT_COMPACTIONS_PER_TURN)
    .map(({ runId, usage: { compactions = 0, turns } }) => makeFinding({
      kind: 'frequent-compaction', severity: 'warn', label: 'inefficient', agentName, subject: runId,
      message: `Run '${runId}' compacted its history ${compactions} times in ${turns} turns; raise contextSize, shrink tool results (maxResultTokens, shaping) or lower compaction.compactTo`,
      evidence: { compactions, turns },
    }));
}

function isSuccess(run: RunRecord): boolean {
  return run.status === 'completed' && run.userVerdict !== 'incorrect';
}

function successRate(runs: readonly RunRecord[]): number {
  return runs.length === 0 ? 0 : runs.filter(isSuccess).length / runs.length;
}

/**
 * Compression that hurts: the agent's runs that used it succeed less often than its runs without it (each side with
 * enough runs), or the compressor's time exceeds what the saved tokens were worth. Pure.
 */
function netNegativeCompression(params: { agentName: string; runs: RunRecord[] }): Finding[] {
  const { agentName, runs } = params;
  const compressed = runs.filter(({ compression = [] }) => compression.length > 0);
  if (compressed.length === 0) return [];
  const plain = runs.filter(({ compression = [] }) => compression.length === 0);
  const records = compressed.flatMap(({ compression = [] }) => compression);
  const tokensSaved = records.reduce((total, { originalTokens, compressedTokens }) => total + originalTokens - compressedTokens, 0);
  const latencyMs = records.reduce((total, record) => total + record.latencyMs, 0);
  const successRateWith = roundRate(successRate(compressed));
  const successRateWithout = roundRate(successRate(plain));
  const isLessReliable = compressed.length >= MIN_RUNS_PER_SIDE && plain.length >= MIN_RUNS_PER_SIDE && successRateWith < successRateWithout;
  const isSlower = latencyMs > tokensSaved * MS_PER_SAVED_TOKEN;
  if (!isLessReliable && !isSlower) return [];
  const reason = isLessReliable
    ? `runs with it succeeded ${successRateWith * 100}% of the time against ${successRateWithout * 100}% without`
    : `it took ${latencyMs} ms to save ${tokensSaved} tokens`;
  return [makeFinding({
    kind: 'compression-net-negative', severity: 'warn', label: 'inefficient', agentName, subject: agentName,
    message: `Compression for agent '${agentName}' looks net negative: ${reason}; tune it (fields, targetRatio) or turn it off`,
    evidence: { runsWithCompression: compressed.length, runsWithout: plain.length, successRateWith, successRateWithout, tokensSaved, latencyMs },
  })];
}

/** Context economy findings: compaction and compression. Pure. */
export function contextFindings(params: { agentName: string; runs: RunRecord[] }): Finding[] {
  return [...frequentCompaction(params), ...netNegativeCompression(params)];
}
