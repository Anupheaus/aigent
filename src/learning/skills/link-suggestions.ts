import type { ToolSuggestion } from '../../scoring/report-types.js';
import { SKILL_NAME_PREFIX } from './distil.js';
import type { Skill } from './skill-types.js';

/** Skill names are cut to the longest tool name, like the distiller cuts them. */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * The report's tool suggestions with the skills distilled from the same sequence (same name, shared supporting runs),
 * so a consumer sees which suggestions already have a candidate, shadow or active skill.
 */
export function linkSuggestionsToSkills(params: { suggestions: ToolSuggestion[]; skills: Skill[] }): ToolSuggestion[] {
  const { suggestions, skills } = params;
  return suggestions.map(suggestion => {
    const runs = new Set(suggestion.supportingRunIds);
    const linked = skills
      .filter(({ name, supportingRunIds }) => name === `${SKILL_NAME_PREFIX}${suggestion.name}`.slice(0, MAX_TOOL_NAME_LENGTH) && supportingRunIds.some(runId => runs.has(runId)))
      .map(({ id, agentName, status, version }) => ({ id, agentName, status, version }));
    return linked.length === 0 ? suggestion : { ...suggestion, skills: linked };
  });
}
