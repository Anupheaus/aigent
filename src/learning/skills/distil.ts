import { alignOccurrences, bindSequenceArguments } from '../../analysis/sequence-bindings.js';
import type { BoundParam } from '../../analysis/sequence-bindings.js';
import { mineSequences } from '../../analysis/sequence-mining.js';
import { toolNameFor } from '../../analysis/tool-suggestions.js';
import type { JsonSchema } from '../../providers/provider-types.js';
import type { RunTrace } from '../../telemetry/run-record.js';
import type { Tool } from '../../tools/tool-types.js';
import type { SkillCandidate, SkillExample, SkillRefusal } from './skill-types.js';

export const SKILL_NAME_PREFIX = 'skill_';
export const DEFAULT_MIN_SUPPORT = 3;
export const DEFAULT_MAX_STEPS = 6;
/** Two runs are the least that can tell a constant from a parameter. */
const MIN_POSSIBLE_SUPPORT = 2;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_EXAMPLES = 3;
const SEQUENCE_JOINER = ' -> ';

export interface DistilSkillsParams {
  traces: RunTrace[];
  /** The agent's tools: unknown tools, nested skills and (unless allowed) tools with side effects are refused. */
  tools: Tool[];
  agentName: string;
  minSupport?: number;
  maxSteps?: number;
  allowSideEffects?: boolean;
  /** Told about every sequence that did not become a candidate, and why. */
  onRefused?(refusal: SkillRefusal): void;
}

function argsSchemaOf(params: BoundParam[]): JsonSchema {
  const properties = Object.fromEntries([...params].sort((left, right) => (left.name < right.name ? -1 : 1)).map(({ name, type }) => [name, { type }]));
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

function examplesOf(params: { boundParams: BoundParam[]; runIds: string[] }): SkillExample[] {
  const { boundParams, runIds } = params;
  return runIds.slice(0, MAX_EXAMPLES).map((runId, run) => ({ args: Object.fromEntries(boundParams.map(({ name, values }) => [name, values[run]])), summary: `as in run ${runId}` }));
}

/** Why a sequence's tools rule it out, or undefined when they are fine. */
function toolProblem(params: { tools: string[]; byName: Map<string, Tool>; allowSideEffects: boolean }): string | undefined {
  const { tools, byName, allowSideEffects } = params;
  const unknown = tools.filter(name => !byName.has(name));
  if (unknown.length > 0) return `uses tools the agent does not have: ${unknown.join(', ')}`;
  const nested = tools.filter(name => name.startsWith(SKILL_NAME_PREFIX) || byName.get(name)?.composedTools != null);
  if (nested.length > 0) return `contains a skill or composed tool (${nested.join(', ')}); skills do not nest`;
  const mutating = tools.filter(name => byName.get(name)?.hasSideEffects === true);
  if (mutating.length > 0 && !allowSideEffects) return `has side effects (${[...new Set(mutating)].join(', ')}); pass allowSideEffects to distil it with an approval on each such step`;
  return undefined;
}

/**
 * Skill candidates from recurring tool sequences of successful runs: completed, never rated incorrect, ending in a step
 * the agent called a success, in at least `minSupport` distinct runs. Argument values are aligned across the runs into
 * constants, parameters and `fromStep` bindings. Deterministic: input order never matters.
 */
export function distilSkills(params: DistilSkillsParams): SkillCandidate[] {
  const { traces, tools, agentName, allowSideEffects = false, onRefused } = params;
  const minSupport = Math.max(MIN_POSSIBLE_SUPPORT, params.minSupport ?? DEFAULT_MIN_SUPPORT);
  const maxSteps = params.maxSteps ?? DEFAULT_MAX_STEPS;
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const successful = traces.filter(({ run }) => run.agentName === agentName && run.status === 'completed' && run.userVerdict !== 'incorrect' && run.dryRun !== true);
  const candidates: SkillCandidate[] = [];
  for (const sequence of mineSequences(successful, { minLength: 2, maxLength: maxSteps, minSupport })) {
    const refuse = (reason: string): void => onRefused?.({ tools: sequence.tools, reason });
    const problem = toolProblem({ tools: sequence.tools, byName, allowSideEffects });
    if (problem != null) { refuse(problem); continue; }
    const occurrences = alignOccurrences({ sequence, traces: successful });
    const binding = bindSequenceArguments(occurrences);
    if (!binding.ok) { refuse(binding.reason); continue; }
    const name = `${SKILL_NAME_PREFIX}${toolNameFor(sequence.tools)}`.slice(0, MAX_TOOL_NAME_LENGTH);
    const runIds = occurrences.map(({ runId }) => runId);
    candidates.push({
      name, agentName,
      description: `Runs ${sequence.tools.join(SEQUENCE_JOINER)} in one call, as ${sequence.support} successful runs did; returns each step's result and the last one's as \`result\`.`,
      argsSchema: argsSchemaOf(binding.params),
      steps: binding.steps.map(({ tool, args }) => ({ tool, args, onFailure: 'stop' })),
      preconditions: [],
      examples: examplesOf({ boundParams: binding.params, runIds }),
      stats: { supportingRuns: sequence.support, replayPass: 0, uses: 0, successRate: 0 },
      ...(allowSideEffects && sequence.tools.some(tool => byName.get(tool)?.hasSideEffects === true) ? { allowSideEffects: true } : {}),
      supportingRunIds: [...runIds].sort(),
    });
  }
  return candidates;
}
