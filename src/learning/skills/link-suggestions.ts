import type { ToolSuggestion } from '../../scoring/report-types.js';
import type { Skill } from './skill-types.js';

/** How a suggestion writes the sequences it replaces. */
const SEQUENCE_JOINER = ' -> ';

/**
 * The report's tool suggestions with the skills distilled from the same sequence (a sequence the suggestion replaces,
 * and shared supporting runs), so a consumer sees which suggestions already have a candidate, shadow or active skill.
 * Matched on the tool sequence, not the name: a suggestion is named after its distinct tools, a skill after all of them.
 */
export function linkSuggestionsToSkills(params: { suggestions: ToolSuggestion[]; skills: Skill[] }): ToolSuggestion[] {
  const { suggestions, skills } = params;
  return suggestions.map(suggestion => {
    const runs = new Set(suggestion.supportingRunIds);
    const sequences = new Set(suggestion.replaces);
    const linked = skills
      .filter(({ steps, supportingRunIds }) => sequences.has(steps.map(({ tool }) => tool).join(SEQUENCE_JOINER)) && supportingRunIds.some(runId => runs.has(runId)))
      .map(({ id, agentName, status, version }) => ({ id, agentName, status, version }));
    return linked.length === 0 ? suggestion : { ...suggestion, skills: linked };
  });
}
