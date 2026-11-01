import type { Finding } from '../scoring/report-types.js';
import type { ProposedVariant } from './strategy-types.js';

/** A variant the library proposes from a finding; it still needs the consumer's approval to enter a trial. */
export interface SuggestedVariant {
  /** The finding's id, so the same finding is never suggested twice. */
  source: string;
  proposal: ProposedVariant;
}

/** A finding that could not become a suggestion, and why. */
export interface SkippedSuggestion {
  source: string;
  reason: string;
}

const SLOW_OR_VERBOSE: ReadonlySet<string> = new Set(['slow-tool', 'verbose-tool']);

function adviceFor(kind: string): string {
  return kind === 'slow-tool' ? 'It is slow: call it only when you need it, and batch its calls.' : 'Its results are long: ask only for what you need.';
}

/**
 * Fixed-template suggestions from the agent's findings (texts never quote run content): `unbatched-repeats` becomes a
 * batching hint for that tool, `slow-tool` and `verbose-tool` a description of the tool with advice added. Findings
 * for tools the agent does not have are skipped and reported.
 */
export function suggestVariants(params: { findings: Finding[]; agentName: string; toolDescriptions: Map<string, string> }): { suggested: SuggestedVariant[]; skipped: SkippedSuggestion[] } {
  const { findings, agentName, toolDescriptions } = params;
  const suggested: SuggestedVariant[] = [];
  const skipped: SkippedSuggestion[] = [];
  for (const { id, kind, subject } of findings.filter(finding => finding.agentName === agentName).sort((left, right) => (left.id < right.id ? -1 : 1))) {
    if (kind !== 'unbatched-repeats' && !SLOW_OR_VERBOSE.has(kind)) continue;
    const description = toolDescriptions.get(subject);
    if (description == null) { skipped.push({ source: id, reason: `the agent has no tool '${subject}'` }); continue; }
    if (kind === 'unbatched-repeats') {
      suggested.push({ source: id, proposal: { label: `Batch ${subject} calls`, changes: [{ kind: 'batching-hint', text: `Call ${subject} once for all the items you need, or put independent calls together in aigent_multi, instead of one call per turn.` }] } });
      continue;
    }
    suggested.push({ source: id, proposal: { label: `Describe ${subject} (${kind})`, changes: [{ kind: 'tool-description', tool: subject, text: `${description} ${adviceFor(kind)}` }] } });
  }
  return { suggested, skipped };
}
