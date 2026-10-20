import { z } from 'zod';
import type { ToolCache } from '../cache/cache-types.js';
import { defineTool } from './define-tool.js';
import { executeToolCall, rejectToolCall } from './execute-tool-call.js';
import type { ExecutedToolCall } from './execute-tool-call.js';
import { addErrorDetails } from './tool-error-detail.js';
import type { ToolErrorDetail } from './tool-error-detail.js';
import type { PlannedEffect } from '../effects/planned-effects.js';
import type { CapturedEffect } from '../effects/undo-types.js';
import type { ToolEnvelope } from './tool-envelope.js';
import type { ToolRegistry } from './tool-registry.js';
import type { MultiToolContext, Tool, ToolContext, ToolOutcome } from './tool-types.js';

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
  /** The runtime's tool-result cache, so inner calls are cached like top-level ones. */
  cache?: ToolCache;
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

function hasDispatcher(context: ToolContext): context is MultiToolContext {
  return typeof (context as Partial<MultiToolContext>).runInnerCall === 'function';
}

/** `aigent_multi` cannot call itself: one level of batching is enough, and nesting would hide calls from the budget. */
export function nestedMultiError(): ToolErrorDetail {
  return { category: 'denied', code: 'nested_multi', retryable: false, message: `${MULTI_TOOL_NAME} cannot call itself`, suggestion: 'Call the underlying tools directly.' };
}

function refused(call: MultiCall, error: ToolErrorDetail): ExecutedToolCall {
  return rejectToolCall({ call: { id: call.id, name: call.tool, args: call.args }, error });
}

/** Built-in tool that runs several different tools in one model call, returning one envelope per call. */
export function createMultiTool(options: CreateMultiToolOptions): Tool {
  const { registry, now, cache } = options;
  /** The executed inner calls behind each result this tool returned, so nested failures come from full, untruncated results. */
  const executedByResult = new WeakMap<object, ExecutedToolCall[]>();

  /**
   * Without a run (direct use) nothing can gate a call or record it, so inner calls to tools that need approval are
   * refused rather than run unchecked.
   */
  function runDirectly(params: { call: MultiCall; context: ToolContext }): Promise<ExecutedToolCall> {
    const { call, context } = params;
    if (call.tool === MULTI_TOOL_NAME) return Promise.resolve(refused(call, nestedMultiError()));
    const requiresApproval = registry.get(call.tool)?.requiresApproval;
    if (requiresApproval != null && requiresApproval !== false) {
      return Promise.resolve(refused(call, { category: 'denied', code: 'approval_required', retryable: false, message: `Inner call '${call.id}' to '${call.tool}' needs approval, which only a run can ask for`, suggestion: `Call '${call.tool}' directly.` }));
    }
    return executeToolCall({ registry, call: { id: call.id, name: call.tool, args: call.args }, context, now, ...(cache == null ? {} : { cache }) });
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
      // In a run, each inner call takes the dispatcher's path; the inner tools only ever see the public context.
      const executedCalls = await Promise.all(args.calls.map(call => (hasDispatcher(context) ? context.runInnerCall(call) : runDirectly({ call, context }))));
      const envelopes = executedCalls.map(({ envelope }) => envelope);
      executedByResult.set(envelopes, executedCalls);
      return envelopes;
    },
  });
  /** The dry-run effects of the inner calls behind a result this tool returned. */
  const plannedEffects = (result: unknown): PlannedEffect[] => {
    const executedCalls = typeof result === 'object' && result !== null ? executedByResult.get(result) : undefined;
    return executedCalls?.flatMap(executed => executed.plannedEffects ?? []) ?? [];
  };
  /** The effects of the inner calls with side effects behind a result this tool returned. */
  const capturedEffects = (result: unknown): CapturedEffect[] => {
    const executedCalls = typeof result === 'object' && result !== null ? executedByResult.get(result) : undefined;
    return executedCalls?.flatMap(executed => executed.effects ?? []) ?? [];
  };
  return { ...tool, summarise: summariseMulti, nestedFailures, plannedEffects, capturedEffects };
}
