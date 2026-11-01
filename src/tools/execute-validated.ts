import type { CacheLookup, ToolCache } from '../cache/cache-types.js';
import { captureEffect } from '../effects/capture-effect.js';
import { simulateCall } from '../effects/dry-run.js';
import type { ToolCall } from '../providers/provider-types.js';
import { boundedLookup } from './bounded-lookup.js';
import type { ExecutedToolCall, ShapeResult } from './execute-tool-call.js';
import { abortedToolError, runTool } from './run-tool.js';
import { failedCall, succeededCall } from './tool-call-result.js';
import { describeThrown } from './tool-error-detail.js';
import type { Tool, ToolContext } from './tool-types.js';

/** A call whose tool exists and whose arguments passed validation. */
export interface ValidatedCallParams {
  call: ToolCall;
  tool: Tool;
  args: unknown;
  context: ToolContext;
  elapsed(): number;
  shape?: ShapeResult;
}

/** A dry run's mutating call: simulated by the tool's `dryRun` (never cached or shaped), or refused without one. */
export async function executeSimulated(params: ValidatedCallParams): Promise<ExecutedToolCall> {
  const { call, tool, args, context, elapsed } = params;
  const simulated = await simulateCall({ tool, args, context });
  if (!simulated.ok) return failedCall({ call, error: simulated.error, durationMs: elapsed() });
  // The tool's own result helpers describe real results, not simulated ones.
  const { summarise: _summarise, nestedFailures: _nested, countItems: _count, plannedEffects: _planned, capturedEffects: _captured, ...plain } = tool;
  const executed = succeededCall({ call, tool: { ...plain, summarise: () => ({ success: true, reason: 'simulated (dry run)' }) }, result: simulated.simulated, durationMs: elapsed() });
  return { ...executed, plannedEffects: simulated.simulated.effects };
}

/** Runs a validated call (no cache); a call with side effects has its effect captured before the model is told. */
export async function executeValidated(params: ValidatedCallParams): Promise<ExecutedToolCall> {
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
export async function executeCached(params: ValidatedCallParams & { cache: ToolCache }): Promise<ExecutedToolCall> {
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
export function failOnThrow(params: { execution: Promise<ExecutedToolCall>; call: ToolCall; elapsed(): number }): Promise<ExecutedToolCall> {
  const { execution, call, elapsed } = params;
  return execution.catch((error: unknown) => failedCall({ call, error: describeThrown(error), durationMs: elapsed() }));
}
