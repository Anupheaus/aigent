import type { RunRecord } from '../telemetry/run-record.js';
import { groupSorted, makeFinding } from './finding-rules.js';
import type { Finding } from './report-types.js';

/**
 * One finding per guardrail that blocked something (or failed its check) in the agent's runs: how often, in how many
 * runs, with which codes. Blocks cost the agent a step or an answer, so frequent ones point at a prompt or tool to fix. Pure.
 */
export function guardrailFindings(params: { agentName: string; runs: RunRecord[] }): Finding[] {
  const { agentName, runs } = params;
  const blocks = runs.flatMap(({ runId, guardrails = [] }) => guardrails.filter(({ action, isBlocking }) => action === 'block' || (action === 'error' && isBlocking === true)).map(decision => ({ runId, decision })));
  return groupSorted({ items: blocks, keyOf: ({ decision: { guardrail } }) => guardrail }).map(([guardrail, entries]) => {
    const runCount = new Set(entries.map(({ runId }) => runId)).size;
    const codes = [...new Set(entries.flatMap(({ decision: { code } }) => (code == null ? [] : [code])))];
    return makeFinding({
      kind: 'guardrail', severity: 'warn', label: 'inefficient', agentName, subject: guardrail,
      message: `Guardrail '${guardrail}' blocked ${entries.length} time(s) in ${runCount} run(s) (${codes.join(', ') || 'no code'})`,
      evidence: { blocks: entries.length, runs: runCount, codes },
    });
  });
}
