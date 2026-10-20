// Test-only fake clock and sleep. Excluded from the build (see tsconfig.build.json) and never exported.
import type { Clock, Sleeper } from '../core/runtime-services.js';

export interface FakeTime {
  clock: Clock;
  sleep: Sleeper;
  /** Moves time forward, waking each sleeper at its own deadline (in order) and letting its continuations run. */
  advance(ms: number): Promise<void>;
  /** Sleepers still waiting: a leak check once everything has settled. */
  pendingSleeps(): number;
}

interface PendingSleep {
  wakeAt: number;
  /** Tie-breaker so sleepers with the same deadline wake in the order they started. */
  order: number;
  wake(): void;
}

/** Lets every queued promise continuation run before time moves again. */
export function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export function createFakeTime(start = 0): FakeTime {
  let now = start;
  let nextOrder = 0;
  const pending: PendingSleep[] = [];

  const sleep: Sleeper = (ms, signal) => new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const entry: PendingSleep = { wakeAt: now + ms, order: nextOrder, wake: () => undefined };
    nextOrder += 1;
    const remove = (): void => { const index = pending.indexOf(entry); if (index !== -1) pending.splice(index, 1); };
    const onAbort = (): void => { remove(); resolve(); };
    entry.wake = () => { signal.removeEventListener('abort', onAbort); remove(); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.push(entry);
  });

  async function advance(ms: number): Promise<void> {
    const target = now + ms;
    await flush();
    for (;;) {
      const due = pending.filter(entry => entry.wakeAt <= target).sort((left, right) => left.wakeAt - right.wakeAt || left.order - right.order)[0];
      if (due == null) break;
      now = due.wakeAt;
      due.wake();
      await flush();
    }
    now = target;
    await flush();
  }

  return { clock: { now: () => now }, sleep, advance, pendingSleeps: () => pending.length };
}
