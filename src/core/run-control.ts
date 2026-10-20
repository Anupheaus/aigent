import type { StopOptions } from './agent-types.js';

export type AbortReason = 'user' | 'timeout';

/** Mutable control surface shared between the run and its `stop`/`cancel` handles. */
export interface RunControl {
  abortController: AbortController;
  /**
   * Given to tools with side effects instead of the run signal: an immediate stop lets them finish so writes are not
   * left half-done, unless it was forced (`force: true`) or the run hit its `timeoutMs`.
   */
  sideEffectSignal: AbortSignal;
  isGracefulStopRequested(): boolean;
  /**
   * Aborts on any stop, graceful included: waits that only a person can end (pending approvals) give up on it, so a
   * graceful stop never hangs on an undecided request.
   */
  stopSignal: AbortSignal;
  /** Why the run was aborted, set before aborting. */
  abortReason(): AbortReason | undefined;
  /** Stops the run from inside (e.g. its instance lost its lease), as `run.stop` does. */
  stop(options?: StopOptions): void;
}

/** Why the run signal aborted, as `signal.reason`; aborted tools quote it so their error says what really happened. */
const ABORT_REASON_TEXT: Record<AbortReason, string> = {
  user: 'the run was stopped',
  timeout: 'the run reached its timeoutMs limit',
};

const FORCED_REASON_TEXT = 'the run was stopped with force';

export interface CreateRunControlParams {
  /** Consumer's signal; aborting it cancels the run. */
  signal?: AbortSignal;
  /** Aborts the run with reason 'timeout' after this many milliseconds. */
  timeoutMs?: number;
}

export interface RunControlHandle {
  control: RunControl;
  /** Repeated calls, and calls after `dispose`, are no-ops (a later forced stop still aborts side-effecting tools). */
  stop(options?: StopOptions): void;
  /** Clears the timeout timer and detaches from the consumer's signal. Call once the run settles. */
  dispose(): void;
}

/** Owns everything that can stop a run (stop/cancel, the consumer's signal, the timeout) and guarantees it is torn down. */
export function createRunControl(params: CreateRunControlParams): RunControlHandle {
  const { signal, timeoutMs } = params;
  const abortController = new AbortController();
  const sideEffectController = new AbortController();
  const stopController = new AbortController();
  const onRunAbort = (): void => { stopController.abort(abortController.signal.reason); };
  abortController.signal.addEventListener('abort', onRunAbort, { once: true });
  let isGracefulStopRequested = false;
  let abortReason: AbortReason | undefined;
  let isDisposed = false;

  function abortWith(reason: AbortReason): void {
    if (isDisposed || abortController.signal.aborted) return;
    abortReason = reason;
    abortController.abort(ABORT_REASON_TEXT[reason]);
    // A hard limit leaves nothing running, writes included.
    if (reason === 'timeout') sideEffectController.abort(ABORT_REASON_TEXT[reason]);
  }

  function stop(options: StopOptions = {}): void {
    const { mode = 'immediate', force = false } = options;
    if (isDisposed) return;
    if (mode === 'graceful') {
      isGracefulStopRequested = true;
      if (!stopController.signal.aborted) stopController.abort('the run was stopped');
      return;
    }
    abortWith('user');
    if (force && !sideEffectController.signal.aborted) sideEffectController.abort(FORCED_REASON_TEXT);
  }

  const onExternalAbort = (): void => abortWith('user');
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (signal?.aborted === true) abortWith('user');
  const timer = timeoutMs != null ? setTimeout(() => abortWith('timeout'), timeoutMs) : undefined;

  function dispose(): void {
    isDisposed = true;
    if (timer != null) clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
    abortController.signal.removeEventListener('abort', onRunAbort);
  }

  const control: RunControl = {
    abortController,
    sideEffectSignal: sideEffectController.signal,
    stopSignal: stopController.signal,
    isGracefulStopRequested: () => isGracefulStopRequested,
    abortReason: () => abortReason,
    stop: options => stop(options),
  };
  return { control, stop, dispose };
}
