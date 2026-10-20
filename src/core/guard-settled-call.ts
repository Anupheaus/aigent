import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import { MULTI_TOOL_NAME } from '../tools/multi-tool.js';
import { COMMENTARY_TOOLS } from './dispatch-tool-call.js';
import type { RunGuardrails } from './run-guardrails.js';

/**
 * A resumed run's settled call through the toolResult checks; bookkeeping results and aigent_multi wrappers (whose
 * inner calls were checked one by one) pass as they are.
 */
export function guardSettledCall(checks: RunGuardrails): (executed: ExecutedToolCall) => Promise<ExecutedToolCall> {
  return async executed => (COMMENTARY_TOOLS.has(executed.envelope.tool) || executed.envelope.tool === MULTI_TOOL_NAME ? executed : checks.checkToolResult(executed));
}
