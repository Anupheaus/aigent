import { z } from 'zod';
import { defineTool } from './define-tool.js';
import { executeToolCall } from './execute-tool-call.js';
import type { ToolEnvelope } from './tool-envelope.js';
import type { ToolRegistry } from './tool-registry.js';
import type { Tool, ToolOutcome } from './tool-types.js';

export const MULTI_TOOL_NAME = 'aigent_multi';
const MAX_MULTI_CALLS = 20;
const MAX_ID_LENGTH = 64;

const multiArgsSchema = z.object({
  calls: z.array(z.object({
    id: z.string().min(1).max(MAX_ID_LENGTH),
    tool: z.string().min(1).max(MAX_ID_LENGTH),
    // JSON string because a strict schema cannot describe arbitrary per-tool argument objects.
    argsJson: z.string().max(100_000),
  }).strict()).min(1).max(MAX_MULTI_CALLS),
}).strict().refine(
  value => new Set(value.calls.map(call => call.id)).size === value.calls.length,
  { message: 'call ids must be unique within one aigent_multi call', path: ['calls'] },
);

function summariseMulti(result: unknown): ToolOutcome {
  const envelopes = Array.isArray(result) ? result as ToolEnvelope[] : [];
  const failed = envelopes.filter(envelope => !envelope.ok).length;
  if (failed === 0) return { success: true, reason: `${envelopes.length} of ${envelopes.length} calls succeeded` };
  return { success: false, reason: `${failed} of ${envelopes.length} calls failed` };
}

/** Built-in tool that runs several different tools in one model call, returning one envelope per call. */
export function createMultiTool(registry: ToolRegistry): Tool {
  const tool = defineTool({
    name: MULTI_TOOL_NAME,
    description: 'Run several tool calls at once. Each call needs a unique id, the tool name and its arguments as a JSON string. Returns one result per call in order; only retry the ones that failed.',
    args: multiArgsSchema,
    deterministic: false,
    cache: false,
    describeActivity: args => ({ title: `Running ${args.calls.length} tool calls`, detail: args.calls.map(call => call.tool).join(', ') }),
    run: async (args, context) => Promise.all(args.calls.map(async (call): Promise<ToolEnvelope> => {
      if (call.tool === MULTI_TOOL_NAME) {
        return { id: call.id, tool: call.tool, ok: false, error: { category: 'denied', code: 'nested_multi', retryable: false, message: `${MULTI_TOOL_NAME} cannot call itself`, suggestion: 'Call the underlying tools directly.' } };
      }
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(call.argsJson);
      } catch (error) { // model-written JSON is untrusted input
        const reason = error instanceof Error ? error.message : String(error);
        return { id: call.id, tool: call.tool, ok: false, error: { category: 'validation', code: 'invalid_args_json', retryable: true, message: `argsJson for call '${call.id}' is not valid JSON: ${reason}` } };
      }
      const executed = await executeToolCall({ registry, call: { id: call.id, name: call.tool, args: parsedArgs }, context, now: Date.now });
      return executed.envelope;
    })),
  });
  return { ...tool, summarise: summariseMulti };
}
