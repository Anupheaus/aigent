import type { RunRecord } from '../telemetry/run-record.js';
import { makeFinding } from './finding-rules.js';
import type { Finding } from './report-types.js';

/** A run needs at least this many compactions... */
const MIN_FREQUENT_COMPACTIONS = 2;
/** ...at more than this many per turn (one every five turns) to count as compacting too often. */
const FREQUENT_COMPACTIONS_PER_TURN = 0.2;

/**
 * Runs that compacted their history so often that each compaction barely bought any turns: every compaction is a
 * prompt-cache miss and possibly a summariser call. Pure.
 */
export function contextFindings(params: { agentName: string; runs: RunRecord[] }): Finding[] {
  const { agentName, runs } = params;
  return runs.filter(({ usage: { compactions = 0, turns } }) => compactions >= MIN_FREQUENT_COMPACTIONS && turns > 0 && compactions / turns > FREQUENT_COMPACTIONS_PER_TURN)
    .map(({ runId, usage: { compactions = 0, turns } }) => makeFinding({
      kind: 'frequent-compaction', severity: 'warn', label: 'inefficient', agentName, subject: runId,
      message: `Run '${runId}' compacted its history ${compactions} times in ${turns} turns; raise contextSize, shrink tool results (maxResultTokens, shaping) or lower compaction.compactTo`,
      evidence: { compactions, turns },
    }));
}
