import type { FeedbackCollector } from '../feedback/feedback-collector.js';
import { createFeedbackTool } from '../feedback/feedback-tool.js';
import { withFeedbackFields } from '../feedback/with-feedback-fields.js';
import { createMultiTool } from '../tools/multi-tool.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { Tool } from '../tools/tool-types.js';

export interface BuildAgentRegistryParams {
  /** The agent definition's tools. */
  tools: Tool[];
  /** Present when feedback is enabled: receives `aigent_feedback` entries. */
  feedbackCollector?: FeedbackCollector;
  now(): number;
}

/**
 * The agent's tools plus the built-ins: `aigent_multi` always, and with feedback on, `aigent_feedback` and the
 * `previous` field on every other tool. `aigent_multi`'s inner calls reach the plain user tools only, so they never
 * carry `previous` and a user tool named like a built-in is a duplicate.
 */
export function buildAgentRegistry(params: BuildAgentRegistryParams): ToolRegistry {
  const { tools, feedbackCollector, now } = params;
  const multiTool = createMultiTool({ registry: createToolRegistry(tools), now });
  if (feedbackCollector == null) return createToolRegistry([...tools, multiTool]);
  return createToolRegistry([...[...tools, multiTool].map(withFeedbackFields), createFeedbackTool({ collector: feedbackCollector })]);
}
