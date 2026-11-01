import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { LEASES_COLLECTION } from './checkpoint-types.js';
import { createFencedStore } from './fencing-store.js';
import type { LeaseRecord } from './lease.js';

const INSTANCE = 'inst';
const COLLECTION = 'checkpoints';
const KEY = 'k';

/** A store that runs `interleave` just before its `pauseAt`-th operation (0-based), so another owner can act mid-write. */
function interleavingStore(params: { store: Store; pauseAt: number; interleave(): Promise<void> }): Store & { hasInterleaved(): boolean } {
  const { store, pauseAt, interleave } = params;
  let operations = 0;
  let hasInterleaved = false;
  const step = async (): Promise<void> => {
    const current = operations;
    operations += 1;
    if (current === pauseAt) { hasInterleaved = true; await interleave(); }
  };
  return {
    hasInterleaved: () => hasInterleaved,
    get: async (collection, key) => { await step(); return store.get(collection, key); },
    list: async collection => { await step(); return store.list(collection); },
    compareAndSet: async write => { await step(); return store.compareAndSet(write); },
    delete: async (collection, key) => { await step(); return store.delete?.(collection, key); },
  };
}

/** Takes the lease over for owner B: the same compare-and-set an acquisition does, with the next fence. */
async function takeOver(store: Store): Promise<number> {
  const stored = await store.get<LeaseRecord>(LEASES_COLLECTION, INSTANCE);
  const fence = (stored?.value.fence ?? 0) + 1;
  await store.compareAndSet<LeaseRecord>({ collection: LEASES_COLLECTION, key: INSTANCE, expectedVersion: stored?.version, value: { instanceId: INSTANCE, ownerId: 'B', fence, expiresAt: 0 } });
  return fence;
}

async function leaseFor(store: Store, fence: number): Promise<void> {
  await store.compareAndSet<LeaseRecord>({ collection: LEASES_COLLECTION, key: INSTANCE, expectedVersion: undefined, value: { instanceId: INSTANCE, ownerId: 'A', fence, expiresAt: 0 } });
}

type StaleWrite = 'create' | 'update' | 'delete';

/** Runs A's (fence 1) write with B's takeover and B's own write to the same key injected before A's `pauseAt`-th store call. */
async function raceAt(params: { pauseAt: number; write: StaleWrite }) {
  const { pauseAt, write } = params;
  const base = createInMemoryStore();
  await leaseFor(base, 1);
  const ownerB = createFencedStore({ store: base, instanceId: INSTANCE, fence: () => 2 });
  if (write !== 'create') await createFencedStore({ store: base, instanceId: INSTANCE, fence: () => 1 }).compareAndSet({ collection: COLLECTION, key: KEY, expectedVersion: undefined, value: { by: 'A-before' } });
  const interleave = async (): Promise<void> => {
    await takeOver(base);
    const current = await base.get(COLLECTION, KEY);
    expect(await ownerB.compareAndSet({ collection: COLLECTION, key: KEY, expectedVersion: current?.version, value: { by: 'B' } })).toBe(true);
  };
  const interleaving = interleavingStore({ store: base, pauseAt, interleave });
  const ownerA = createFencedStore({ store: interleaving, instanceId: INSTANCE, fence: () => 1 });
  const attempt = write === 'delete'
    ? ownerA.delete!(COLLECTION, KEY).then(() => true)
    : ownerA.compareAndSet({ collection: COLLECTION, key: KEY, expectedVersion: write === 'create' ? undefined : 1, value: { by: 'A-stale' } });
  const outcome = await attempt.then(isWritten => ({ isWritten }), (error: unknown) => ({ error }));
  // A finished before the pause point: B takes over and writes after it, as the next owner would.
  const isConcurrent = interleaving.hasInterleaved();
  if (!isConcurrent) await interleave();
  return { outcome, isConcurrent, stored: (await base.get<{ by: string }>(COLLECTION, KEY))?.value };
}

describe('createFencedStore under an interleaved takeover', () => {
  // Every point at which B can take over and write while A's write is in progress: the record B wrote is never
  // replaced or removed by A, and A learns its write did not land (false, or a fenced store_conflict).
  for (const write of ['create', 'update', 'delete'] as const) {
    for (const pauseAt of [0, 1, 2, 3, 4, 5]) {
      it(`never lets a stale ${write} replace the new owner's record (takeover before store call ${pauseAt})`, async () => {
        const { outcome, isConcurrent, stored } = await raceAt({ pauseAt, write });
        expect(stored).toMatchObject({ by: 'B' });
        if (!isConcurrent) expect(outcome).toEqual({ isWritten: true });
        else if ('error' in outcome) expect(outcome.error).toMatchObject({ code: 'store_conflict', details: { fenced: true } });
        else expect(outcome.isWritten).toBe(false);
      });
    }
  }

  it('lets the new owner replace a record the stale owner wrote after the takeover, and fences the stale owner from then on', async () => {
    const base = createInMemoryStore();
    await leaseFor(base, 1);
    const ownerA = createFencedStore({ store: base, instanceId: INSTANCE, fence: () => 1 });
    // A's check passed before the takeover, so its write may land; it is ordered before anything B writes.
    const late = createFencedStore({ store: interleavingStore({ store: base, pauseAt: 1, interleave: async () => { await takeOver(base); } }), instanceId: INSTANCE, fence: () => 1 });
    expect(await late.compareAndSet({ collection: COLLECTION, key: KEY, expectedVersion: undefined, value: { by: 'A-late' } })).toBe(true);
    const ownerB = createFencedStore({ store: base, instanceId: INSTANCE, fence: () => 2 });
    expect(await ownerB.compareAndSet({ collection: COLLECTION, key: KEY, expectedVersion: undefined, value: { by: 'B' } })).toBe(true);
    expect((await base.get(COLLECTION, KEY))?.value).toMatchObject({ by: 'B', leaseFence: 2 });
    await expect(ownerA.compareAndSet({ collection: COLLECTION, key: 'other', expectedVersion: undefined, value: { by: 'A' } })).rejects.toMatchObject({ code: 'store_conflict', details: { fenced: true } });
  });

  it('keeps plain create semantics between writers of the same fence', async () => {
    const base = createInMemoryStore();
    await leaseFor(base, 1);
    const owner = createFencedStore({ store: base, instanceId: INSTANCE, fence: () => 1 });
    expect(await owner.compareAndSet({ collection: COLLECTION, key: KEY, expectedVersion: undefined, value: { n: 1 } })).toBe(true);
    expect(await owner.compareAndSet({ collection: COLLECTION, key: KEY, expectedVersion: undefined, value: { n: 2 } })).toBe(false);
  });

  it('refuses values that cannot carry a fence', async () => {
    const owner = createFencedStore({ store: createInMemoryStore(), instanceId: INSTANCE, fence: () => 0 });
    await expect(owner.compareAndSet({ collection: COLLECTION, key: KEY, expectedVersion: undefined, value: 'text' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('fenced store list', () => {
  it('passes list options through to the store it wraps, still hiding tombstones', async () => {
    const base = createInMemoryStore();
    const seen: unknown[] = [];
    const spying: Store = { ...base, list: (collection, options) => { seen.push(options); return base.list(collection, options); } };
    await leaseFor(base, 1);
    const fenced = createFencedStore({ store: spying, instanceId: INSTANCE, fence: () => 1 });
    await fenced.compareAndSet({ collection: COLLECTION, key: 'mine', expectedVersion: undefined, value: { agentName: 'a' } });
    await fenced.compareAndSet({ collection: COLLECTION, key: 'other', expectedVersion: undefined, value: { agentName: 'b' } });
    expect((await fenced.list(COLLECTION, { where: { agentName: 'a' } })).map(({ key }) => key)).toEqual(['mine']);
    expect(seen).toEqual([{ where: { agentName: 'a' } }]);
  });
});
