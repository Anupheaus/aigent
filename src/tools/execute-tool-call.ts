import type { ToolCall } from '../providers/provider-types.js';
import { parseToolArgs } from './parse-tool-args.js';
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
}

export interface ExecuteToolCallParams {
  registry: ToolRegistry;
  call: ToolCall;
  /** The run's context; the call's own id is added as `callId`. */
  context: Omit<ToolContext, 'callId'>;
  now(): number;
}

const TIMEOUT_MARKER = Symbol('tool-timeout');
const ABORT_MARKER = Symbol('tool-abort');
type Marker = typeof TIMEOUT_MARKER | typeof ABORT_MARKER;

interface FailedCallParams {
  call: ToolCall;
  error: ToolErrorDetail;
  durationMs: number;
}

interface RaceWithLimitsParams {
  work: Promise<unknown>;
  timeoutMs: number;
  signal: AbortSignal;
}

interface SucceededCallParams {
  call: ToolCall;
  tool: Tool;
  result: unknown;
  durationMs: number;
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

/** Races the tool against its timeout and the run's abort signal, always cleaning up the timer and listener. */
function raceWithLimits(params: RaceWithLimitsParams): Promise<unknown> {
  const { work, timeoutMs, signal } = params;
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

/** The run sets a readable `signal.reason` (stopped, timed out, provider failed); anything else is reported generically. */
function abortReasonText(signal: AbortSignal): string {
  const { reason } = signal;
  return typeof reason === 'string' && reason !== '' ? reason : 'its run signal was aborted';
}

/** Executes one tool call. Never rejects: every failure becomes a structured envelope. */
export async function executeToolCall(params: ExecuteToolCallParams): Promise<ExecutedToolCall> {
  const { registry, call, now } = params;
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
  try {
    // Wrapped so a plain return value (JavaScript consumers, casts) still counts as success and a synchronous throw becomes a rejection.
    const work = new Promise<unknown>(resolve => resolve(tool.run(parsed.value, context)));
    const result = await raceWithLimits({ work, timeoutMs: tool.timeoutMs, signal: context.signal });
    if (result === TIMEOUT_MARKER) {
      return failedCall({ call, error: { category: 'timeout', code: 'tool_timeout', retryable: true, message: `Tool '${tool.name}' did not finish within ${tool.timeoutMs} ms` }, durationMs: elapsed() });
    }
    if (result === ABORT_MARKER) {
      return failedCall({ call, error: { category: 'aborted', code: 'tool_aborted', retryable: false, message: `Tool '${tool.name}' was aborted because ${abortReasonText(context.signal)}` }, durationMs: elapsed() });
    }
    return succeededCall({ call, tool, result, durationMs: elapsed() });
  } catch (error) {
    return failedCall({ call, error: describeThrown(error), durationMs: elapsed() });
  }
}
