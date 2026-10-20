import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Sleeper } from '../core/runtime-services.js';
import { LEASES_COLLECTION } from './checkpoint-types.js';
import { createFencedStore } from './fencing-store.js';
import { acquireLease } from './lease.js';
import type { LeaseRecord } from './lease.js';

/** A sleeper that only resolves when told (or aborted), counting the waits still pending. */
function manualSleeper() {
  const pending = new Set<() => void>();
  const sleep: Sleeper = (_ms, signal) => new Promise(resolve => {
    const done = (): void => { pending.delete(done); signal.removeEventListener('abort', done); resolve(); };
    pending.add(done);
    signal.addEventListener('abort', done, { once: true });
  });
  return { sleep, pending: () => pending.size, tick: async () => { for (const done of [...pending]) done(); await new Promise(resolve => setImmediate(resolve)); } };
}

function setup() {
  const store = createInMemoryStore();
  let now = 1_000;
  const clock = { now: () => now };
  const timers = manualSleeper();
  const acquire = (ownerId: string) => acquireLease({ store, instanceId: 'inst', ownerId, ttlMs: 3_000, clock, sleep: timers.sleep });
  return { store, clock, timers, acquire, advance: (ms: number) => { now += ms; } };
}

describe('acquireLease', () => {
  it('acquires a free lease with fence 1 and refuses a second owner while it is unexpired', async () => {
    const { acquire } = setup();
    const first = await acquire('a');
    expect(first.fence).toBe(1);
    await expect(acquire('b')).rejects.toMatchObject({ code: 'instance_locked', details: { instanceId: 'inst', ownerId: 'a' } });
    await first.release();
  });

  it('renews on its heartbeat, so the lease does not expire while held', async () => {
    const { acquire, store, timers, advance } = setup();
    const lease = await acquire('a');
    advance(2_000);
    await timers.tick();
    const record = await store.get<LeaseRecord>(LEASES_COLLECTION, 'inst');
    expect(record?.value.expiresAt).toBe(1_000 + 2_000 + 3_000);
    await lease.release();
  });

  it('lets another owner take over after expiry with a higher fence, and fences the old owner', async () => {
    const { acquire, store, advance } = setup();
    const first = await acquire('a');
    advance(5_000);
    const second = await acquire('b');
    expect(second.fence).toBe(2);
    await expect(first.renew()).rejects.toMatchObject({ code: 'store_conflict', details: { fenced: true } });
    const stale = createFencedStore({ store, instanceId: 'inst', fence: () => first.fence });
    await expect(stale.compareAndSet({ collection: 'checkpoints', key: 'k', expectedVersion: undefined, value: { n: 1 } })).rejects.toMatchObject({ code: 'store_conflict', details: { fenced: true } });
    const current = createFencedStore({ store, instanceId: 'inst', fence: () => second.fence });
    expect(await current.compareAndSet({ collection: 'checkpoints', key: 'k', expectedVersion: undefined, value: { n: 1 } })).toBe(true);
    await first.release();
    await second.release();
  });

  it('release expires the lease at once and leaves no heartbeat timer behind', async () => {
    const { acquire, timers } = setup();
    const lease = await acquire('a');
    expect(timers.pending()).toBe(1);
    await lease.release();
    expect(timers.pending()).toBe(0);
    const next = await acquire('b');
    expect(next.fence).toBe(2);
    await next.release();
    await lease.release();
    expect(timers.pending()).toBe(0);
  });

  it('reports a lost lease from the heartbeat and stops renewing', async () => {
    const store = createInMemoryStore();
    let now = 0;
    const timers = manualSleeper();
    const lost: unknown[] = [];
    const lease = await acquireLease({ store, instanceId: 'i', ownerId: 'a', ttlMs: 30, clock: { now: () => now }, sleep: timers.sleep, onLost: error => lost.push(error) });
    now = 100;
    const thief = await acquireLease({ store, instanceId: 'i', ownerId: 'b', ttlMs: 30, clock: { now: () => now }, sleep: timers.sleep });
    await timers.tick();
    expect(lost).toEqual([expect.objectContaining({ code: 'store_conflict' })]);
    await lease.release();
    await thief.release();
    expect(timers.pending()).toBe(0);
  });
});
