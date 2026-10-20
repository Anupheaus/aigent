import type { ToolCall } from '../providers/provider-types.js';
import { parseToolArgs } from './parse-tool-args.js';
import { describeThrown } from './tool-error-detail.js';
import type { ToolErrorDetail } from './tool-error-detail.js';
import type { ToolEnvelope } from './tool-envelope.js';
import type { ToolRegistry } from './tool-registry.js';
import type { ToolContext, ToolOutcome } from './tool-types.js';

export interface ExecutedToolCall {
  envelope: ToolEnvelope;
  outcome: ToolOutcome;
  durationMs: number;
}

export interface ExecuteToolCallParams {
  registry: ToolRegistry;
  call: ToolCall;
  context: ToolContext;
  now(): number;
}

const TIMEOUT_MARKER = Symbol('tool-timeout');
const ABORT_MARKER = Symbol('tool-abort');
type Marker = typeof TIMEOUT_MARKER | typeof ABORT_MARKER;

function failedCall(call: ToolCall, error: ToolErrorDetail, durationMs: number): ExecutedToolCall {
  return {
    envelope: { id: call.id, tool: call.name, ok: false, error },
    outcome: { success: false, reason: error.message },
    durationMs,
  };
}

/** Builds a failed result without running anything, e.g. when a limit forbids the call. */
export function rejectToolCall(params: { call: ToolCall; error: ToolErrorDetail }): ExecutedToolCall {
  return failedCall(params.call, params.error, 0);
}

/** Races the tool against its timeout and the run's abort signal, always cleaning up the timer and listener. */
function raceWithLimits(work: Promise<unknown>, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  // An abandoned (timed out / aborted) tool may reject later; that must not become an unhandled rejection.
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const limits = new Promise<Marker>(resolve => {
    timer = setTimeout(() => resolve(TIMEOUT_MARKER), timeoutMs);
    if (signal.aborted) resolve(ABORT_MARKER);
    onAbort = () => resolve(ABORT_MARKER);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, limits]).finally(() => {
    if (timer != null) clearTimeout(timer);
    if (onAbort != null) signal.removeEventListener('abort', onAbort);
  });
}

/** Executes one tool call. Never rejects: every failure becomes a structured envelope. */
export async function executeToolCall(params: ExecuteToolCallParams): Promise<ExecutedToolCall> {
  const { registry, call, context, now } = params;
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const tool = registry.get(call.name);
  if (tool == null) {
    return failedCall(call, {
      category: 'unknown_tool', code: 'unknown_tool', retryable: true,
      message: `Unknown tool '${call.name}'`,
      suggestion: `Available tools: ${registry.names().join(', ')}`,
    }, elapsed());
  }
  const parsed = parseToolArgs(tool.argsSchema, call.args);
  if (!parsed.ok) {
    return failedCall(call, {
      category: 'validation', code: 'invalid_arguments', retryable: true,
      message: `Arguments for '${tool.name}' failed validation: ${parsed.fieldErrors.map(fieldError => `${fieldError.path || '(root)'}: ${fieldError.message}`).join('; ')}`,
      fieldErrors: parsed.fieldErrors,
      suggestion: 'Fix the listed arguments and call the tool again.',
    }, elapsed());
  }
  try {
    const result = await raceWithLimits(tool.run(parsed.value, context), tool.timeoutMs, context.signal);
    if (result === TIMEOUT_MARKER) {
      return failedCall(call, { category: 'timeout', code: 'tool_timeout', retryable: true, message: `Tool '${tool.name}' did not finish within ${tool.timeoutMs} ms` }, elapsed());
    }
    if (result === ABORT_MARKER) {
      return failedCall(call, { category: 'aborted', code: 'tool_aborted', retryable: false, message: `Tool '${tool.name}' was aborted because the run was stopped` }, elapsed());
    }
    return {
      envelope: { id: call.id, tool: call.name, ok: true, result },
      outcome: tool.summarise?.(result) ?? { success: true, reason: 'completed' },
      durationMs: elapsed(),
    };
  } catch (error) {
    return failedCall(call, describeThrown(error), elapsed());
  }
}
