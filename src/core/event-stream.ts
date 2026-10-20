export type StreamRun<TEvent, TResult> = AsyncIterable<TEvent> & PromiseLike<TResult>;

export interface EventStream<TEvent, TResult> {
  push(event: TEvent): void;
  finish(result: TResult): void;
  fail(error: unknown): void;
  run: StreamRun<TEvent, TResult>;
}

type Settlement = { kind: 'finished' } | { kind: 'failed'; error: unknown };

/** Buffers every event so any number of iterators (before, during or after the run) see the same sequence. */
export function createEventStream<TEvent, TResult>(): EventStream<TEvent, TResult> {
  const events: TEvent[] = [];
  let settlement: Settlement | undefined;
  let waiters: (() => void)[] = [];
  let resolveResult: (result: TResult) => void = () => undefined;
  let rejectResult: (error: unknown) => void = () => undefined;
  const resultPromise = new Promise<TResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Failure is reported through awaiters and iterators; this keeps an unobserved failure from becoming an unhandled rejection.
  resultPromise.catch(() => undefined);

  function wakeWaiters(): void {
    const pending = waiters;
    waiters = [];
    for (const wake of pending) wake();
  }

  async function* iterate(): AsyncGenerator<TEvent> {
    let index = 0;
    for (;;) {
      if (index < events.length) { yield events[index] as TEvent; index += 1; continue; }
      if (settlement != null) {
        if (settlement.kind === 'failed') throw settlement.error;
        return;
      }
      await new Promise<void>(resolve => waiters.push(resolve));
    }
  }

  const run: StreamRun<TEvent, TResult> = {
    [Symbol.asyncIterator]: iterate,
    then: (onFulfilled, onRejected) => resultPromise.then(onFulfilled, onRejected),
  };

  return {
    push(event) { events.push(event); wakeWaiters(); },
    finish(result) { settlement = { kind: 'finished' }; resolveResult(result); wakeWaiters(); },
    fail(error) { settlement = { kind: 'failed', error }; rejectResult(error); wakeWaiters(); },
    run,
  };
}
