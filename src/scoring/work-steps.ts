import { FEEDBACK_TOOL_NAME } from '../feedback/feedback-tool.js';
import type { TraceStep } from '../telemetry/run-record.js';
import { MULTI_TOOL_NAME } from '../tools/multi-tool.js';

/** `aigent_multi` only wraps other calls and `aigent_feedback` is commentary: neither is tool work to judge. */
const NON_WORK_TOOLS = new Set([MULTI_TOOL_NAME, FEEDBACK_TOOL_NAME]);

export function isWorkStep(step: TraceStep): boolean {
  return !NON_WORK_TOOLS.has(step.tool);
}

/** Work calls the model made directly, each its own call (inner `aigent_multi` calls were batched by the model). */
export function topLevelWorkSteps(steps: TraceStep[]): TraceStep[] {
  return steps.filter(step => step.parentCallId == null && isWorkStep(step));
}
