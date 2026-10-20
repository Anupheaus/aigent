import type { RunTrace } from '../telemetry/run-record.js';
import { makeFinding } from './finding-rules.js';
import type { Finding } from './report-types.js';

interface ShaperTotals {
  applications: number;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * A shaper that, summed over the agent's runs, left results as large as or larger than it found them: its notes and
 * markers cost more than it saved, so it should be disallowed for this agent (`shapers: { allow }`). Pure.
 */
export function shaperFindings(params: { agentName: string; traces: RunTrace[] }): Finding[] {
  const { agentName, traces } = params;
  const byShaper = new Map<string, ShaperTotals>();
  for (const { steps } of traces) {
    for (const { shaped = [] } of steps) {
      for (const { shaper, tokensBefore, tokensAfter } of shaped) {
        const totals = byShaper.get(shaper) ?? { applications: 0, tokensBefore: 0, tokensAfter: 0 };
        byShaper.set(shaper, { applications: totals.applications + 1, tokensBefore: totals.tokensBefore + tokensBefore, tokensAfter: totals.tokensAfter + tokensAfter });
      }
    }
  }
  return [...byShaper.entries()]
    .filter(([, { tokensBefore, tokensAfter }]) => tokensAfter >= tokensBefore)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([shaper, evidence]) => makeFinding({
      kind: 'net-negative-shaper', severity: 'warn', label: 'inefficient', agentName, subject: shaper,
      message: `Shaper '${shaper}' did not shrink results (${evidence.tokensBefore} tokens before, ${evidence.tokensAfter} after, over ${evidence.applications} results); leave it out with shapers: { allow }`,
      evidence: { ...evidence },
    }));
}
