import { isCacheable } from '../cache/is-cacheable.js';
import type { ToolCache } from '../cache/cache-types.js';
import type { ToolCall } from '../providers/provider-types.js';
import type { ShapedStep } from '../shapers/shaper-types.js';
import type { GuardrailDecisionRecord } from '../guardrails/guardrail-types.js';
import type { CapturedEffect } from '../effects/undo-types.js';
import type { PlannedEffect } from '../effects/planned-effects.js';
import { executeCached, executeSimulated, executeValidated, failOnThrow } from './execute-validated.js';
import type { ValidatedCallParams } from './execute-validated.js';
import { parseToolArgs } from './parse-tool-args.js';
import { failedCall } from './tool-call-result.js';
import type { ToolErrorDetail } from './tool-error-detail.js';
import type { ToolEnvelope } from './tool-envelope.js';
import type { ToolRegistry } from './tool-registry.js';
import type { ItemCounts, Tool, ToolContext, ToolOutcome } from './tool-types.js';
import type { ResultSize } from './truncate-result.js';

export interface ExecutedToolCall {
  /** What the model sees; an oversize result is replaced by the truncation marker. */
  envelope: ToolEnvelope;
  outcome: ToolOutcome;
  durationMs: number;
  /** Size of the full result (or of the error), measured before truncation. */
  size: ResultSize;
  /** Failures inside a successful aggregate result, taken from the full result so truncation never hides one. */
  nested: ToolErrorDetail[];
  /** Batch item totals, when the tool reports them. */
  items?: ItemCounts;
  /** Set for cacheable tools when a cache is in use: true when the result was served from it. */
  cacheHit?: boolean;
  /** On a cache hit: how long the original call took. */
  savedMs?: number;
  /** Shapers that changed what the model sees, with token estimates before and after each. */
  shaped?: ShapedStep[];
  /** Guardrail decisions about this call and its result. */
  guardrails?: GuardrailDecisionRecord[];
  /** Dry runs: what the call (or the calls inside it) would have done. */
  plannedEffects?: PlannedEffect[];
  /** Calls with side effects that ran (this one, or the ones inside it), with their undo data. */
  effects?: CapturedEffect[];
}

/** What the model should see of a successful result (the original, or its shaped form), and what shaping did. */
export interface ShapedValue {
  value: unknown;
  shaped: ShapedStep[];
}

/** Shapes a successful full result for the model; the cache and telemetry keep the original. */
export type ShapeResult = (params: { tool: Tool; callId: string; value: unknown }) => ShapedValue;

export interface ExecuteToolCallParams {
  registry: ToolRegistry;
  call: ToolCall;
  /** The run's context; the call's own id is added as `callId`. */
  context: Omit<ToolContext, 'callId'>;
  now(): number;
  /** Looked up before a cacheable tool runs and filled after it succeeds. */
  cache?: ToolCache;
  /** Applied to successful results after the cache stored them and before truncation. */
  shape?: ShapeResult;
  /** Replaces the tool's own `timeoutMs` (`Infinity`: no timeout). */
  timeoutMs?: number;
}

/** Builds a failed result without running anything, e.g. when a limit forbids the call. */
export function rejectToolCall(params: { call: ToolCall; error: ToolErrorDetail }): ExecutedToolCall {
  const { call, error } = params;
  return failedCall({ call, error, durationMs: 0 });
}

/** Executes one tool call. Never rejects: every failure becomes a structured envelope. */
export async function executeToolCall(params: ExecuteToolCallParams): Promise<ExecutedToolCall> {
  const { registry, call, now, cache, shape, timeoutMs } = params;
  const context: ToolContext = { ...params.context, callId: call.id };
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const registered = registry.get(call.name);
  const tool = registered == null || timeoutMs == null ? registered : { ...registered, timeoutMs };
  if (tool == null) {
    return failedCall({
      call,
      error: {
        category: 'unknown_tool', code: 'unknown_tool', retryable: true,
        message: `Unknown tool '${call.name}'`,
        suggestion: `Available tools: ${registry.names().join(', ')}`,
      },
      durationMs: elapsed(),
    });
  }
  const parsed = parseToolArgs(tool.argsSchema, call.args);
  if (!parsed.ok) {
    return failedCall({
      call,
      error: {
        category: 'validation', code: 'invalid_arguments', retryable: true,
        message: `Arguments for '${tool.name}' failed validation: ${parsed.fieldErrors.map(fieldError => `${fieldError.path || '(root)'}: ${fieldError.message}`).join('; ')}`,
        fieldErrors: parsed.fieldErrors,
        suggestion: 'Fix the listed arguments and call the tool again.',
      },
      durationMs: elapsed(),
    });
  }
  const validated: ValidatedCallParams = { call, tool, args: parsed.value, context, elapsed, ...(shape == null ? {} : { shape }) };
  // A dry run never runs a mutating tool: it simulates it or refuses it (fail closed), and bypasses the cache.
  if (context.dryRun === true && tool.hasSideEffects) return failOnThrow({ execution: executeSimulated(validated), call, elapsed });
  // Uncached tools take the synchronous path, so `run` starts before this returns and calls start in arrival order.
  if (cache == null || !isCacheable(tool)) return failOnThrow({ execution: executeValidated(validated), call, elapsed });
  return failOnThrow({ execution: executeCached({ ...validated, cache }), call, elapsed });
}
