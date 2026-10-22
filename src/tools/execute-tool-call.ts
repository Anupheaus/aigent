import { isCacheable } from '../cache/is-cacheable.js';
import type { CacheLookup, ToolCache } from '../cache/cache-types.js';
import type { ToolCall } from '../providers/provider-types.js';
import type { ShapedStep } from '../shapers/shaper-types.js';
import type { GuardrailDecisionRecord } from '../guardrails/guardrail-types.js';
import { simulateCall } from '../effects/dry-run.js';
import { captureEffect } from '../effects/capture-effect.js';
import type { CapturedEffect } from '../effects/undo-types.js';
import type { PlannedEffect } from '../effects/planned-effects.js';
import { boundedLookup } from './bounded-lookup.js';
import { parseToolArgs } from './parse-tool-args.js';
import { abortedToolError, runTool } from './run-tool.js';
import { describeThrown } from './tool-error-detail.js';
import type { ToolErrorDetail } from './tool-error-detail.js';
import type { ToolEnvelope } from './tool-envelope.js';
import type { ToolRegistry } from './tool-registry.js';
import type { ItemCounts, Tool, ToolContext, ToolOutcome } from './tool-types.js';
import { truncateResult } from './truncate-result.js';
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

interface FailedCallParams {
  call: ToolCall;
  error: ToolErrorDetail;
  durationMs: number;
}

interface SucceededCallParams {
  call: ToolCall;
  tool: Tool;
  result: unknown;
  durationMs: number;
  shape?: ShapeResult;
}

interface ValidatedCallParams {
  call: ToolCall;
  tool: Tool;
  args: unknown;
  context: ToolContext;
  elapsed(): number;
  shape?: ShapeResult;
}

function failedCall(params: FailedCallParams): ExecutedToolCall {
  const { call, error, durationMs } = params;
  // Failures are never truncated: the model needs the whole error to recover.
  const { size } = truncateResult({ result: error });
  return {
    envelope: { id: call.id, tool: call.name, ok: false, error },
    outcome: { success: false, reason: error.message },
    durationMs,
    size,
    nested: [],
  };
}

/**
 * Everything telemetry and error reporting need is taken from the full result; the model sees its shaped form,
 * truncated to the tool's budget.
 */
function succeededCall(params: SucceededCallParams): ExecutedToolCall {
  const { call, tool, result, durationMs, shape } = params;
  const { size } = truncateResult({ result });
  const shapedValue = shape?.({ tool, callId: call.id, value: result }) ?? { value: result, shaped: [] };
  const { result: visible, size: { truncated } } = truncateResult({ result: shapedValue.value, maxResultTokens: tool.maxResultTokens });
  const items = tool.countItems?.(result);
  const planned = tool.plannedEffects?.(result) ?? [];
  const inner = tool.capturedEffects?.(result) ?? [];
  return {
    envelope: { id: call.id, tool: call.name, ok: true, result: visible },
    outcome: tool.summarise?.(result) ?? { success: true, reason: 'completed' },
    durationMs,
    size: { ...size, truncated },
    nested: tool.nestedFailures?.(result) ?? [],
    ...(items == null ? {} : { items }),
    ...(shapedValue.shaped.length === 0 ? {} : { shaped: shapedValue.shaped }),
    ...(planned.length === 0 ? {} : { plannedEffects: planned }),
    ...(inner.length === 0 ? {} : { effects: inner }),
  };
}

/** A dry run's mutating call: simulated by the tool's `dryRun` (never cached or shaped), or refused without one. */
async function executeSimulated(params: ValidatedCallParams): Promise<ExecutedToolCall> {
  const { call, tool, args, context, elapsed } = params;
  const simulated = await simulateCall({ tool, args, context });
  if (!simulated.ok) return failedCall({ call, error: simulated.error, durationMs: elapsed() });
  // The tool's own result helpers describe real results, not simulated ones.
  const { summarise: _summarise, nestedFailures: _nested, countItems: _count, plannedEffects: _planned, capturedEffects: _captured, ...plain } = tool;
  const executed = succeededCall({ call, tool: { ...plain, summarise: () => ({ success: true, reason: 'simulated (dry run)' }) }, result: simulated.simulated, durationMs: elapsed() });
  return { ...executed, plannedEffects: simulated.simulated.effects };
}

/** Builds a failed result without running anything, e.g. when a limit forbids the call. */
export function rejectToolCall(params: { call: ToolCall; error: ToolErrorDetail }): ExecutedToolCall {
  const { call, error } = params;
  return failedCall({ call, error, durationMs: 0 });
}

async function executeValidated(params: ValidatedCallParams): Promise<ExecutedToolCall> {
  const { call, tool, args, context, elapsed, shape } = params;
  const outcome = await runTool({ tool, args, context });
  if (!outcome.ok) return failedCall({ call, error: outcome.error, durationMs: elapsed() });
  const executed = succeededCall({ call, tool, result: outcome.result, durationMs: elapsed(), shape });
  if (!tool.hasSideEffects) return executed;
  // The effect happened: it is recorded (with undo data from the full result) before the model is told.
  const effect = await captureEffect({ tool, args, result: outcome.result, context });
  return { ...executed, effects: [effect, ...executed.effects ?? []] };
}

/** Serves a hit, or runs the call and stores its full result; failures are never stored. */
async function executeCached(params: ValidatedCallParams & { cache: ToolCache }): Promise<ExecutedToolCall> {
  const { call, tool, args, context, elapsed, cache, shape } = params;
  const lookup: CacheLookup = { tool, args, context };
  const looked = await boundedLookup({ cache, lookup });
  if (looked.isAborted) return { ...failedCall({ call, error: abortedToolError({ tool, signal: context.signal }), durationMs: elapsed() }), cacheHit: false };
  const { hit } = looked;
  if (hit != null) return { ...succeededCall({ call, tool, result: hit.value, durationMs: elapsed(), shape }), cacheHit: true, savedMs: hit.savedMs };
  try {
    const outcome = await runTool({ tool, args, context });
    if (!outcome.ok) return { ...failedCall({ call, error: outcome.error, durationMs: elapsed() }), cacheHit: false };
    // The cache stores the full original; only the copy the model sees is shaped.
    const executed = succeededCall({ call, tool, result: outcome.result, durationMs: elapsed(), shape });
    const { durationMs, size: { resultBytes, resultTokens } } = executed;
    // A retryable item failure (a 503, a timeout) would be replayed to the retry the model was told to make.
    if (!executed.nested.some(({ retryable }) => retryable)) await cache.store({ lookup, value: outcome.result, durationMs, bytes: resultBytes, resultTokens });
    return { ...executed, cacheHit: false };
  } finally {
    // A no-op once `store` ran. Otherwise the call failed, or shaping, summarising or storing threw: identical calls
    // waiting on this miss must be released, or they (and every later identical call) would wait forever.
    cache.abandon(lookup);
  }
}

/** Shaping and the tool's own `summarise`/`countItems`/`nestedFailures` may throw; that becomes the call's failure. */
function failOnThrow(params: { execution: Promise<ExecutedToolCall>; call: ToolCall; elapsed(): number }): Promise<ExecutedToolCall> {
  const { execution, call, elapsed } = params;
  return execution.catch((error: unknown) => failedCall({ call, error: describeThrown(error), durationMs: elapsed() }));
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
