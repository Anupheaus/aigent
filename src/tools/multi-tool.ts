import { z } from 'zod';
import { defineTool } from './define-tool.js';
import { executeToolCall, rejectToolCall } from './execute-tool-call.js';
import type { ExecutedToolCall } from './execute-tool-call.js';
import { addErrorDetails } from './tool-error-detail.js';
import type { ToolErrorDetail } from './tool-error-detail.js';
import type { ToolEnvelope } from './tool-envelope.js';
import type { ToolRegistry } from './tool-registry.js';
import type { FinishInnerCall, InnerCall, MultiToolContext, Tool, ToolContext, ToolOutcome } from './tool-types.js';

export const MULTI_TOOL_NAME = 'aigent_multi';
const MAX_MULTI_CALLS = 20;
const MAX_ID_LENGTH = 64;
/** Headroom over the slowest inner tool's timeout, so inner timeouts (not this one) decide which calls failed. */
const MULTI_TIMEOUT_MARGIN_MS = 1_000;

const multiArgsSchema = z.object({
  calls: z.array(z.object({
    id: z.string().min(1).max(MAX_ID_LENGTH),
    tool: z.string().min(1).max(MAX_ID_LENGTH),
    // Free-form because each inner tool has its own arguments; that tool's own schema validates them. This is why
    // aigent_multi opts out of the strict subset (strictSchema: false).
    args: z.record(z.string(), z.unknown()),
  }).strict()).min(1).max(MAX_MULTI_CALLS),
}).strict().refine(
  value => new Set(value.calls.map(call => call.id)).size === value.calls.length,
  { message: 'call ids must be unique within one aigent_multi call', path: ['calls'] },
);

type MultiCall = z.infer<typeof multiArgsSchema>['calls'][number];

export interface CreateMultiToolOptions {
  /** The tools inner calls may reach (never `aigent_multi` itself). */
  registry: ToolRegistry;
  /** The run's clock, so inner call timings come from the same injected time source. */
  now(): number;
}

interface InnerCallParams {
  call: MultiCall;
  context: ToolContext;
  reserveToolCall(): boolean;
  traceInnerCall?(call: InnerCall): FinishInnerCall;
}

function envelopesOf(result: unknown): ToolEnvelope[] {
  return Array.isArray(result) ? result as ToolEnvelope[] : [];
}

function summariseMulti(result: unknown): ToolOutcome {
  const envelopes = envelopesOf(result);
  const failed = envelopes.filter(envelope => !envelope.ok).length;
  if (failed === 0) return { success: true, reason: `${envelopes.length} of ${envelopes.length} calls succeeded` };
  return { success: false, reason: `${failed} of ${envelopes.length} calls failed` };
}

function hasCallBudget(context: ToolContext): context is MultiToolContext {
  return typeof (context as Partial<MultiToolContext>).reserveToolCall === 'function';
}

/** Inner tools get the plain public context; the budget and tracer are only for this tool. Without a budget (direct use) calls are unlimited. */
function splitContext(context: ToolContext): Omit<InnerCallParams, 'call'> {
  if (!hasCallBudget(context)) return { context, reserveToolCall: () => true };
  const { reserveToolCall, traceInnerCall, ...publicContext } = context;
  return { context: publicContext, reserveToolCall, ...(traceInnerCall == null ? {} : { traceInnerCall }) };
}

function refused(call: MultiCall, error: ToolErrorDetail): ExecutedToolCall {
  return rejectToolCall({ call: { id: call.id, name: call.tool, args: call.args }, error });
}

/** Built-in tool that runs several different tools in one model call, returning one envelope per call. */
export function createMultiTool(options: CreateMultiToolOptions): Tool {
  const { registry, now } = options;
  /** The executed inner calls behind each result this tool returned, so nested failures come from full, untruncated results. */
  const executedByResult = new WeakMap<object, ExecutedToolCall[]>();

  async function executeInnerCall(params: InnerCallParams): Promise<ExecutedToolCall> {
    const { call, context, reserveToolCall } = params;
    if (call.tool === MULTI_TOOL_NAME) {
      return refused(call, { category: 'denied', code: 'nested_multi', retryable: false, message: `${MULTI_TOOL_NAME} cannot call itself`, suggestion: 'Call the underlying tools directly.' });
    }
    // Each inner call is a real tool call, so it takes from the run's maxToolCalls budget like a top-level call.
    if (!reserveToolCall()) {
      return refused(call, { category: 'denied', code: 'tool_call_limit', retryable: false, message: `Tool call limit reached; inner call '${call.id}' to '${call.tool}' was not run` });
    }
    return executeToolCall({ registry, call: { id: call.id, name: call.tool, args: call.args }, context, now });
  }

  /** Traced as it starts (so the trace keeps call order, even though calls finish in any order) and when it finishes. */
  async function runInnerCall(params: InnerCallParams): Promise<ExecutedToolCall> {
    const { call: { id, tool, args }, traceInnerCall } = params;
    const finish = traceInnerCall?.({ id, tool, args });
    const executed = await executeInnerCall(params);
    finish?.(executed);
    return executed;
  }

  /** Each envelope's own failures, read from the result's envelopes when this tool did not produce it. */
  function failuresPerCall(result: unknown): ToolErrorDetail[][] {
    const executedCalls = typeof result === 'object' && result !== null ? executedByResult.get(result) : undefined;
    if (executedCalls != null) return executedCalls.map(({ envelope, nested }) => (envelope.ok ? nested : [envelope.error]));
    return envelopesOf(result).map(envelope => (envelope.ok ? registry.get(envelope.tool)?.nestedFailures?.(envelope.result) ?? [] : [envelope.error]));
  }

  /** Inner failures, plus failures nested inside successful inner results (e.g. batch items), tagged with the inner call. */
  function nestedFailures(result: unknown): ToolErrorDetail[] {
    const perCall = failuresPerCall(result);
    return envelopesOf(result).flatMap(({ id: callId, tool }, callIndex) => (perCall[callIndex] ?? []).map(detail => addErrorDetails(detail, { callId, tool })));
  }

  // Inner calls run in parallel and each enforces its own timeout, so the slowest inner timeout bounds the whole call.
  // Without this the 30 s default would cut off slower inner tools and lose every finished result with them.
  const slowestInnerTimeoutMs = Math.max(0, ...registry.list().map(innerTool => innerTool.timeoutMs));
  const tool = defineTool({
    name: MULTI_TOOL_NAME,
    description: 'Run several tool calls at once. Each call is { id, tool, args }: a unique id, the tool name, and args, the argument object exactly as that tool takes it. Returns one result per call in order; only retry the ones that failed.',
    args: multiArgsSchema,
    deterministic: false,
    cache: false,
    strictSchema: false,
    timeoutMs: slowestInnerTimeoutMs + MULTI_TIMEOUT_MARGIN_MS,
    describeActivity: args => ({ title: `Running ${args.calls.length} tool calls`, detail: args.calls.map(call => call.tool).join(', ') }),
    run: async (args, context) => {
      const split = splitContext(context);
      const executedCalls = await Promise.all(args.calls.map(call => runInnerCall({ call, ...split })));
      const envelopes = executedCalls.map(({ envelope }) => envelope);
      executedByResult.set(envelopes, executedCalls);
      return envelopes;
    },
  });
  return { ...tool, summarise: summariseMulti, nestedFailures };
}
