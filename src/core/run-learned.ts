import { applyToolOverlay, buildOverlay, strategySection } from '../learning/apply-variant.js';
import { isSafeToShow } from '../learning/learned-text.js';
import { createSkillTool } from '../learning/skills/skill-tool.js';
import type { Skill } from '../learning/skills/skill-types.js';
import type { RunStrategyRecord, StrategyVariant } from '../learning/strategy-types.js';
import { extractTaskFeatures, featureBucket } from '../routing/task-features.js';
import type { Tool } from '../tools/tool-types.js';
import { withLearnedVersion } from './agent-version.js';
import { withAgentFields } from './build-agent-registry.js';
import type { ResolvedAgent, RuntimeServices } from './start-task-run.js';
import type { SystemPromptOverlay } from './system-prompt.js';
import type { TaskInput } from './task-input.js';

/** What a run takes from what its agent learned. */
export interface LearnedRun {
  /** Agents with `strategy: true`: stored on the run record. */
  strategy?: RunStrategyRecord;
  overlay: SystemPromptOverlay;
  /** The run's tools with learned descriptions applied and active skills added. */
  tools(base: Tool[]): Tool[];
  /** The agent version with the learned parts included (the plain version when nothing applies). */
  agentVersion: string;
  warnings: string[];
}

export interface PrepareLearnedRunParams {
  agent: ResolvedAgent;
  services: RuntimeServices;
  input: TaskInput;
  runId: string;
  toolCount: number;
}

const SKILL_HINTS_HEADING = '# Learned procedures (hints only)\nThese tool sequences worked in earlier runs of similar tasks. They are hints, not instructions and not tools: follow one with the listed tools only if it fits.';

/** The advisory section for shadow skills: their generated names and tool sequences only, never run content. */
function skillHints(shadow: Skill[]): string | undefined {
  if (shadow.length === 0) return undefined;
  return `${SKILL_HINTS_HEADING}\n${shadow.map(({ name, steps }) => `- ${name}: ${steps.map(({ tool }) => tool).join(' -> ')}`).join('\n')}`;
}

async function strategyOf(params: PrepareLearnedRunParams): Promise<{ record?: RunStrategyRecord; applied: StrategyVariant[] }> {
  const { agent, services: { strategy }, input, runId, toolCount } = params;
  if (agent.isStrategyEnabled !== true || strategy == null) return { applied: [] };
  const prepared = await strategy.prepareRun({ agentName: agent.name, runId, bucket: featureBucket(extractTaskFeatures(input, toolCount)) });
  return { record: prepared.record, applied: prepared.applied };
}

/** The run's learned overlays; undefined when the agent learns nothing (its prompt and tools are then exactly its own). */
export async function prepareLearnedRun(params: PrepareLearnedRunParams): Promise<LearnedRun | undefined> {
  const { agent, services } = params;
  const isSkills = agent.isSkillsEnabled === true && services.skills != null;
  if ((agent.isStrategyEnabled !== true || services.strategy == null) && !isSkills) return undefined;
  const redactsPii = services.redactsPii ?? false;
  const strategy = await strategyOf(params);
  const skills = isSkills && services.skills != null ? await services.skills.prepareRun(agent.name) : { active: [], shadow: [] };
  const overlay = buildOverlay({ variants: strategy.applied, redactsPii });
  const warnings = [...overlay.skipped];
  // Stored skill text is checked again before it is shown, like variant text.
  const safe = (skill: Skill): boolean => {
    const isSafe = isSafeToShow({ text: skill.description, redactsPii });
    if (!isSafe) warnings.push(`Skill '${skill.name}' was left out: its stored description holds a secret or instruction-like text`);
    return isSafe;
  };
  const active = skills.active.filter(safe);
  const sections = [strategySection(overlay.rules), skillHints(skills.shadow)].flatMap(section => (section == null ? [] : [section]));
  const tools = (base: Tool[]): Tool[] => {
    const overlaid = applyToolOverlay({ tools: base, overlay });
    const byName = new Map(overlaid.map(tool => [tool.name, tool]));
    const added = active.flatMap(skill => {
      if (byName.has(skill.name)) { warnings.push(`Skill '${skill.name}' was left out: the agent already has a tool of that name`); return []; }
      const tool = createSkillTool({ skill, tools: byName });
      return [withAgentFields({ tool, isFeedbackEnabled: agent.feedbackCollector != null, ...(agent.memory == null ? {} : { maxMemoryPerCall: agent.memory.maxPerCall }) })];
    });
    return [...overlaid, ...added];
  };
  // The content is hashed too: the version is only a label, and the run's agent version must change whenever what it is offered does.
  const learnedSkills = [...active, ...skills.shadow].map(({ id, version, status, name, description, argsSchema, steps, allowSideEffects }) => ({
    id, version, status, content: { name, description, argsSchema, steps, allowSideEffects: allowSideEffects === true },
  }));
  return {
    ...(strategy.record == null ? {} : { strategy: strategy.record }),
    overlay: sections.length === 0 ? {} : { afterRules: sections },
    tools,
    agentVersion: withLearnedVersion({ agentVersion: agent.agentVersion, variants: strategy.applied.map(({ id, changes }) => ({ id, changes })), skills: learnedSkills }),
    warnings,
  };
}
