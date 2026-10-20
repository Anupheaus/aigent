/** Either the work's value, or a note that the signal aborted first. */
export type SignalRace<T> = { isAborted: true } | { isAborted: false; value: T };

export interface RaceSignalParams<T> {
  work: Promise<T>;
  signal: AbortSignal;
}

/**
 * Resolves with the work's value, or as aborted as soon as `signal` aborts (immediately if it already has).
 * Rejections of the work propagate while it is still being waited for. The abort listener is always removed.
 */
export function raceSignal<T>(params: RaceSignalParams<T>): Promise<SignalRace<T>> {
  const { work, signal } = params;
  // Abandoned work may reject later; that must not become an unhandled rejection.
  work.catch(() => undefined);
  if (signal.aborted) return Promise.resolve({ isAborted: true });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<SignalRace<T>>(resolve => {
    onAbort = () => resolve({ isAborted: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const completed = work.then((value): SignalRace<T> => ({ isAborted: false, value }));
  return Promise.race([completed, aborted]).finally(() => {
    if (onAbort != null) signal.removeEventListener('abort', onAbort);
  });
}
