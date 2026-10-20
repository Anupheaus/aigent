import type { StopOptions } from './agent-types.js';
import type { AbortReason, RunControl } from './run-task.js';

export interface CreateRunControlParams {
  /** Consumer's signal; aborting it cancels the run. */
  signal?: AbortSignal;
  /** Aborts the run with reason 'timeout' after this many milliseconds. */
  timeoutMs?: number;
}

export interface RunControlHandle {
  control: RunControl;
  /** Repeated calls, and calls after `dispose`, are no-ops. */
  stop(options?: StopOptions): void;
  /** Clears the timeout timer and detaches from the consumer's signal. Call once the run settles. */
  dispose(): void;
}

/** Owns everything that can stop a run (stop/cancel, the consumer's signal, the timeout) and guarantees it is torn down. */
export function createRunControl(params: CreateRunControlParams): RunControlHandle {
  const { signal, timeoutMs } = params;
  const abortController = new AbortController();
  let isGracefulStopRequested = false;
  let abortReason: AbortReason | undefined;
  let isDisposed = false;

  function abortWith(reason: AbortReason): void {
    if (isDisposed || abortController.signal.aborted) return;
    abortReason = reason;
    abortController.abort();
  }

  function stop(options: StopOptions = {}): void {
    const { mode = 'immediate' } = options;
    if (isDisposed) return;
    if (mode === 'graceful') { isGracefulStopRequested = true; return; }
    abortWith('user');
  }

  const onExternalAbort = (): void => abortWith('user');
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (signal?.aborted === true) abortWith('user');
  const timer = timeoutMs != null ? setTimeout(() => abortWith('timeout'), timeoutMs) : undefined;

  function dispose(): void {
    isDisposed = true;
    if (timer != null) clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }

  const control: RunControl = {
    abortController,
    isGracefulStopRequested: () => isGracefulStopRequested,
    abortReason: () => abortReason,
  };
  return { control, stop, dispose };
}
