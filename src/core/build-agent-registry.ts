import type { ToolCache } from '../cache/cache-types.js';
import type { FeedbackCollector } from '../feedback/feedback-collector.js';
import { createFeedbackTool } from '../feedback/feedback-tool.js';
import { PREVIOUS_FIELD } from '../feedback/previous-outcome.js';
import { withFeedbackFields } from '../feedback/with-feedback-fields.js';
import { MEMORY_FIELD } from '../memory/memory-schema.js';
import { withMemoryField } from '../memory/with-memory-field.js';
import { createMultiTool } from '../tools/multi-tool.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { Tool } from '../tools/tool-types.js';
import { createAigentError } from './aigent-error.js';

/** The memory settings the tool schemas need. */
export interface RegistryMemory {
  maxPerCall: number;
}

export interface BuildAgentRegistryParams {
  /** Named in definition errors. */
  agentName: string;
  /** The agent definition's tools. */
  tools: Tool[];
  /** Present when feedback is enabled: receives `aigent_feedback` entries. */
  feedbackCollector?: FeedbackCollector;
  /** Present when memory is enabled: every work tool (and `aigent_multi`) gets the `memory` field. */
  memory?: RegistryMemory;
  /** The runtime's tool-result cache, used by `aigent_multi` inner calls too. */
  cache?: ToolCache;
  now(): number;
}

interface ReservedArgument {
  field: string;
  /** Says what the field is for and how to free the name. */
  reason: string;
}

/**
 * The loop takes `previous` (feedback on) and `memory` (memory on) out of every call's arguments, so a tool's own
 * argument of either name would never reach it. Failing at definition time beats a tool that fails every call.
 */
function rejectReservedArguments(params: { agentName: string; tool: Tool; reserved: ReservedArgument[] }): void {
  const { agentName, tool: { name, jsonSchema }, reserved } = params;
  const properties = (jsonSchema.properties ?? {}) as object;
  const clash = reserved.find(({ field }) => field in properties);
  if (clash == null) return;
  throw createAigentError({
    code: 'invalid_definition',
    message: `Tool '${name}' of agent '${agentName}' declares an argument named '${clash.field}', which is ${clash.reason}`,
    details: { agentName, tool: name, argument: clash.field },
  });
}

/**
 * The agent's tools plus the built-ins: `aigent_multi` always; with feedback on, `aigent_feedback` and the `previous`
 * field on every other tool; with memory on, the `memory` field on the same tools. `aigent_multi`'s inner calls reach
 * the plain user tools only, so they never carry either field and a user tool named like a built-in is a duplicate.
 */
export function buildAgentRegistry(params: BuildAgentRegistryParams): ToolRegistry {
  const { agentName, tools, feedbackCollector, memory, cache, now } = params;
  const multiTool = createMultiTool({ registry: createToolRegistry(tools), now, ...(cache == null ? {} : { cache }) });
  const reserved: ReservedArgument[] = [
    ...(feedbackCollector == null ? [] : [{ field: PREVIOUS_FIELD, reason: 'reserved for outcome feedback while enableFeedback is on; rename the argument or set enableFeedback: false' }]),
    ...(memory == null ? [] : [{ field: MEMORY_FIELD, reason: 'reserved for memory notes while memory is on; rename the argument or set memory: false' }]),
  ];
  for (const tool of tools) rejectReservedArguments({ agentName, tool, reserved });
  const withFeedback = (tool: Tool): Tool => (feedbackCollector == null ? tool : withFeedbackFields(tool));
  const withMemory = (tool: Tool): Tool => (memory == null ? tool : withMemoryField({ tool, maxPerCall: memory.maxPerCall }));
  const work = [...tools, multiTool].map(tool => withMemory(withFeedback(tool)));
  return createToolRegistry(feedbackCollector == null ? work : [...work, createFeedbackTool({ collector: feedbackCollector })]);
}
