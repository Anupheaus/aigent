import type { RunCheckpoints } from '../resume/checkpoint-hooks.js';
import { isFenced } from '../resume/lease.js';
import type { AigentEvent } from './aigent-events.js';
import type { RunControl } from './run-control.js';

/** A run's view of its instance's lease: whether it is lost, and how a fenced write reports the loss. */
export interface RunLeaseWatch {
  isLost(): boolean;
  /** True when `error` was a fenced write (the lease is then reported lost); false for any other failure. */
  absorbFenced(error: unknown): boolean;
  /** Stops watching once the run has ended. */
  dispose(): void;
}

/**
 * Another process owning the instance is not a failure of this run: once the lease is lost the run emits a warning
 * and stops (at once, or at the next safe boundary with `onLeaseLost: 'graceful'`), and writes nothing more.
 */
export function watchRunLease(params: { checkpoints?: RunCheckpoints; control: RunControl; emit(event: AigentEvent): void }): RunLeaseWatch {
  const { checkpoints, control, emit } = params;
  const lost = checkpoints?.lost;
  const onLost = (): void => {
    emit({ type: 'warning', message: `The run stopped because ${String(lost?.reason)}` });
    control.stop({ mode: checkpoints?.onLeaseLost ?? 'immediate' });
  };
  if (lost?.aborted === true) onLost();
  else lost?.addEventListener('abort', onLost, { once: true });
  return {
    isLost: () => lost?.aborted === true,
    absorbFenced: error => {
      if (!isFenced(error)) return false;
      checkpoints?.reportLost(error);
      return true;
    },
    dispose: () => lost?.removeEventListener('abort', onLost),
  };
}
