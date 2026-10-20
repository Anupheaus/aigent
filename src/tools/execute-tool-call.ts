import { isCacheable } from '../cache/is-cacheable.js';
import type { CacheLookup, ToolCache } from '../cache/cache-types.js';
import type { ToolCall } from '../providers/provider-types.js';
import { parseToolArgs } from './parse-tool-args.js';
import { runTool } from './run-tool.js';
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
}

export interface ExecuteToolCallParams {
  registry: ToolRegistry;
  call: ToolCall;
  /** The run's context; the call's own id is added as `callId`. */
  context: Omit<ToolContext, 'callId'>;
  now(): number;
  /** Looked up before a cacheable tool runs and filled after it succeeds. */
  cache?: ToolCache;
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
}

interface ValidatedCallParams {
  call: ToolCall;
  tool: Tool;
  args: unknown;
  context: ToolContext;
  elapsed(): number;
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

/** Everything telemetry and error reporting need is taken from the full result before the visible one is truncated. */
function succeededCall(params: SucceededCallParams): ExecutedToolCall {
  const { call, tool, result, durationMs } = params;
  const { result: visible, size } = truncateResult({ result, maxResultTokens: tool.maxResultTokens });
  const items = tool.countItems?.(result);
  return {
    envelope: { id: call.id, tool: call.name, ok: true, result: visible },
    outcome: tool.summarise?.(result) ?? { success: true, reason: 'completed' },
    durationMs,
    size,
    nested: tool.nestedFailures?.(result) ?? [],
    ...(items == null ? {} : { items }),
  };
}

/** Builds a failed result without running anything, e.g. when a limit forbids the call. */
export function rejectToolCall(params: { call: ToolCall; error: ToolErrorDetail }): ExecutedToolCall {
  const { call, error } = params;
  return failedCall({ call, error, durationMs: 0 });
}

async function executeValidated(params: ValidatedCallParams): Promise<ExecutedToolCall> {
  const { call, tool, args, context, elapsed } = params;
  const outcome = await runTool({ tool, args, context });
  if (!outcome.ok) return failedCall({ call, error: outcome.error, durationMs: elapsed() });
  return succeededCall({ call, tool, result: outcome.result, durationMs: elapsed() });
}

/** Serves a hit, or runs the call and stores its full result; failures are never stored. */
async function executeCached(params: ValidatedCallParams & { cache: ToolCache }): Promise<ExecutedToolCall> {
  const { call, tool, args, context, elapsed, cache } = params;
  const lookup: CacheLookup = { tool, args, context };
  const hit = await cache.lookup(lookup);
  if (hit != null) return { ...succeededCall({ call, tool, result: hit.value, durationMs: elapsed() }), cacheHit: true, savedMs: hit.savedMs };
  const outcome = await runTool({ tool, args, context });
  if (!outcome.ok) {
    cache.abandon(lookup);
    return { ...failedCall({ call, error: outcome.error, durationMs: elapsed() }), cacheHit: false };
  }
  const executed = succeededCall({ call, tool, result: outcome.result, durationMs: elapsed() });
  const { durationMs, size: { resultBytes, resultTokens } } = executed;
  await cache.store({ lookup, value: outcome.result, durationMs, bytes: resultBytes, resultTokens });
  return { ...executed, cacheHit: false };
}

/** Executes one tool call. Never rejects: every failure becomes a structured envelope. */
export async function executeToolCall(params: ExecuteToolCallParams): Promise<ExecutedToolCall> {
  const { registry, call, now, cache } = params;
  const context: ToolContext = { ...params.context, callId: call.id };
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const tool = registry.get(call.name);
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
  const validated: ValidatedCallParams = { call, tool, args: parsed.value, context, elapsed };
  // Uncached tools take the synchronous path, so `run` starts before this returns and calls start in arrival order.
  if (cache == null || !isCacheable(tool)) return executeValidated(validated);
  return executeCached({ ...validated, cache });
}
