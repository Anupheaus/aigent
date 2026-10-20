import { describeThrown } from './tool-error-detail.js';
import type { ToolErrorDetail } from './tool-error-detail.js';
import type { Tool, ToolContext } from './tool-types.js';

const TIMEOUT_MARKER = Symbol('tool-timeout');
const ABORT_MARKER = Symbol('tool-abort');
type Marker = typeof TIMEOUT_MARKER | typeof ABORT_MARKER;

interface RaceWithLimitsParams {
  work: Promise<unknown>;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface RunToolParams {
  tool: Tool;
  /** Validated arguments. */
  args: unknown;
  context: ToolContext;
}

/** The tool's own result, or the structured failure that replaces it. */
export type RunToolOutcome = { ok: true; result: unknown } | { ok: false; error: ToolErrorDetail };

/** Races the tool against its timeout and the run's abort signal, always cleaning up the timer and listener. */
function raceWithLimits(params: RaceWithLimitsParams): Promise<unknown> {
  const { work, timeoutMs, signal } = params;
  // An abandoned (timed out / aborted) tool may reject later; that must not become an unhandled rejection.
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const limits = new Promise<Marker>(resolve => {
    // An unbounded call (an aigent_multi wrapper whose inner calls enforce their own timeouts) has no timer.
    if (Number.isFinite(timeoutMs)) timer = setTimeout(() => resolve(TIMEOUT_MARKER), timeoutMs);
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

/** The failure of a call whose run signal aborted before it finished (or, for a cached call, before it started). */
export function abortedToolError(params: { tool: Pick<Tool, 'name'>; signal: AbortSignal }): ToolErrorDetail {
  const { tool: { name }, signal } = params;
  return { category: 'aborted', code: 'tool_aborted', retryable: false, message: `Tool '${name}' was aborted because ${abortReasonText(signal)}` };
}

/**
 * Runs a tool within its timeout and the run's signal. Never rejects. `tool.run` is called synchronously, so tools
 * started in arrival order begin in that order.
 */
export async function runTool(params: RunToolParams): Promise<RunToolOutcome> {
  const { tool, args, context } = params;
  try {
    // Wrapped so a plain return value (JavaScript consumers, casts) still counts as success and a synchronous throw becomes a rejection.
    const work = new Promise<unknown>(resolve => resolve(tool.run(args, context)));
    const result = await raceWithLimits({ work, timeoutMs: tool.timeoutMs, signal: context.signal });
    if (result === TIMEOUT_MARKER) {
      return { ok: false, error: { category: 'timeout', code: 'tool_timeout', retryable: true, message: `Tool '${tool.name}' did not finish within ${tool.timeoutMs} ms` } };
    }
    if (result === ABORT_MARKER) return { ok: false, error: abortedToolError({ tool, signal: context.signal }) };
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: describeThrown(error) };
  }
}
