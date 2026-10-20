import type { FeedbackCollector } from '../feedback/feedback-collector.js';
import { createFeedbackTool } from '../feedback/feedback-tool.js';
import { PREVIOUS_FIELD } from '../feedback/previous-outcome.js';
import { withFeedbackFields } from '../feedback/with-feedback-fields.js';
import { createMultiTool } from '../tools/multi-tool.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { Tool } from '../tools/tool-types.js';
import { createAigentError } from './aigent-error.js';

export interface BuildAgentRegistryParams {
  /** Named in definition errors. */
  agentName: string;
  /** The agent definition's tools. */
  tools: Tool[];
  /** Present when feedback is enabled: receives `aigent_feedback` entries. */
  feedbackCollector?: FeedbackCollector;
  now(): number;
}

/**
 * With feedback on, the loop takes `previous` out of every call's arguments, so a tool's own argument of that name
 * would never reach it. Failing at definition time beats a tool that fails every call.
 */
function rejectReservedArguments(params: { agentName: string; tool: Tool }): void {
  const { agentName, tool: { name, jsonSchema } } = params;
  if (!(PREVIOUS_FIELD in ((jsonSchema.properties ?? {}) as object))) return;
  throw createAigentError({
    code: 'invalid_definition',
    message: `Tool '${name}' of agent '${agentName}' declares an argument named '${PREVIOUS_FIELD}', which is reserved for outcome feedback while enableFeedback is on; rename the argument or set enableFeedback: false`,
    details: { agentName, tool: name, argument: PREVIOUS_FIELD },
  });
}

/**
 * The agent's tools plus the built-ins: `aigent_multi` always, and with feedback on, `aigent_feedback` and the
 * `previous` field on every other tool. `aigent_multi`'s inner calls reach the plain user tools only, so they never
 * carry `previous` and a user tool named like a built-in is a duplicate.
 */
export function buildAgentRegistry(params: BuildAgentRegistryParams): ToolRegistry {
  const { agentName, tools, feedbackCollector, now } = params;
  const multiTool = createMultiTool({ registry: createToolRegistry(tools), now });
  if (feedbackCollector == null) return createToolRegistry([...tools, multiTool]);
  for (const tool of tools) rejectReservedArguments({ agentName, tool });
  return createToolRegistry([...[...tools, multiTool].map(withFeedbackFields), createFeedbackTool({ collector: feedbackCollector })]);
}
