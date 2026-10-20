import type { ProviderEvent } from '../providers/provider-types.js';
import { createAigentError } from './aigent-error.js';
import { openStreamIterator } from './open-stream-iterator.js';
import type { Sleeper } from './runtime-services.js';
import { stopStream } from './stop-stream.js';

export interface FirstEventTimeoutParams {
  /** Starts the stream; it is given a signal that also aborts on timeout. */
  open(signal: AbortSignal): AsyncIterable<ProviderEvent>;
  signal: AbortSignal;
  timeoutMs: number;
  sleep: Sleeper;
  /** Names the stream in the timeout error, e.g. `anthropic:claude-sonnet-5-5`. */
  label: string;
}

type FirstStep = { kind: 'event'; result: IteratorResult<ProviderEvent> } | { kind: 'timeout' };

/**
 * Passes the stream through, but fails it with a retryable `provider_failed` (`details.timeout: true`) when no event
 * arrives within `timeoutMs` of opening, aborting the stream. The timer is always cancelled once settled.
 */
export async function* withFirstEventTimeout(params: FirstEventTimeoutParams): AsyncGenerator<ProviderEvent> {
  const { open, signal, timeoutMs, sleep, label } = params;
  const streamController = new AbortController();
  const timerController = new AbortController();
  const forwardAbort = (): void => streamController.abort(signal.reason);
  signal.addEventListener('abort', forwardAbort, { once: true });
  if (signal.aborted) forwardAbort();
  let iterator: AsyncIterator<ProviderEvent> | undefined;
  let isSettled = false;
  // Opening is inside the try so a provider that throws synchronously still has the abort listener removed.
  try {
    const opened = openStreamIterator({ open, signal: streamController.signal, label });
    iterator = opened;
    const first = opened.next();
    // A first event that loses to the timer is abandoned; its later rejection must not go unhandled.
    first.catch(() => undefined);
    // The timer is only cancelled after the race, so winning it always means the time elapsed.
    const timer = sleep(timeoutMs, timerController.signal).then((): FirstStep => ({ kind: 'timeout' }));
    const step = await Promise.race([first.then((result): FirstStep => ({ kind: 'event', result })), timer]).catch((error: unknown) => {
      isSettled = true;
      throw error;
    });
    timerController.abort();
    if (step.kind === 'timeout') {
      streamController.abort(`no event within ${timeoutMs} ms`);
      throw createAigentError({ code: 'provider_failed', message: `Provider '${label}' sent no event within ${timeoutMs} ms`, details: { retryable: true, timeout: true, timeoutMs } });
    }
    if (step.result.done === true) { isSettled = true; return; }
    yield step.result.value;
    for (;;) {
      const result = await opened.next().catch((error: unknown) => { isSettled = true; throw error; });
      if (result.done === true) { isSettled = true; return; }
      yield result.value;
    }
  } finally {
    timerController.abort();
    signal.removeEventListener('abort', forwardAbort);
    if (!isSettled && iterator != null) stopStream(iterator);
  }
}
