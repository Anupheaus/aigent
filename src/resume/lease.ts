import { createAigentError } from '../core/aigent-error.js';
import type { Clock, Sleeper } from '../core/runtime-services.js';
import type { Store } from '../store/store-types.js';
import { LEASES_COLLECTION } from './checkpoint-types.js';

/** The stored lease of one agent instance. */
export interface LeaseRecord {
  instanceId: string;
  ownerId: string;
  /** Increases at every acquisition; writes carrying an older fence are rejected (see `createFencedStore`). */
  fence: number;
  /** Epoch ms; an expired lease may be taken over. */
  expiresAt: number;
}

/** A held lease: renewed by a heartbeat until released. */
export interface Lease {
  fence: number;
  ownerId: string;
  /** Extends the lease by `ttlMs`; rejects with `store_conflict` (`fenced`) once another owner took it over. */
  renew(): Promise<void>;
  /** Stops the heartbeat and expires the lease at once, so another owner can take over. */
  release(): Promise<void>;
}

export interface AcquireLeaseParams {
  store: Store;
  instanceId: string;
  ownerId: string;
  ttlMs: number;
  clock: Clock;
  /** Heartbeat waits (every third of `ttlMs`); inject a fake to control time. */
  sleep: Sleeper;
  /**
   * Called once the lease is lost: another owner took it over, or renewals kept failing (the store was unreachable)
   * until it expired. The heartbeat then stops. A renewal that fails for any other reason is retried.
   */
  onLost?(error: unknown): void;
}

/** Renewals per lease lifetime: a missed heartbeat or two still keeps the lease. */
const HEARTBEATS_PER_TTL = 3;
/** Retries per lease lifetime after a failed renewal, so a store blip is ridden out well before the lease expires. */
const RETRIES_PER_TTL = 10;

/** Whether a store error says another owner took the instance over (or its lease expired unrenewed). */
export function isFenced(error: unknown): boolean {
  const details = (error as { details?: { fenced?: unknown } } | undefined)?.details;
  return typeof error === 'object' && error !== null && details?.fenced === true;
}

function expired(params: { instanceId: string; fence: number; expiresAt: number; cause: unknown }): Error {
  const { instanceId, fence, expiresAt, cause } = params;
  return createAigentError({ code: 'store_conflict', message: `The lease of agent instance '${instanceId}' expired at ${new Date(expiresAt).toISOString()} because it could not be renewed: ${String(cause)}`, details: { fenced: true, expired: true, instanceId, fence, expiresAt } });
}

function locked(params: { instanceId: string; current: LeaseRecord }): Error {
  const { instanceId, current: { ownerId, expiresAt } } = params;
  return createAigentError({ code: 'instance_locked', message: `Agent instance '${instanceId}' is held by '${ownerId}' until ${new Date(expiresAt).toISOString()}; wait for it to expire or release it`, details: { instanceId, ownerId, expiresAt } });
}

function fenced(params: { instanceId: string; fence: number; current?: LeaseRecord }): Error {
  const { instanceId, fence, current } = params;
  return createAigentError({ code: 'store_conflict', message: `The lease of agent instance '${instanceId}' was taken over (fence ${current?.fence ?? 'none'}, held ${fence})`, details: { fenced: true, instanceId, fence, currentFence: current?.fence } });
}

/**
 * Takes the instance's lease with compare-and-set: free, expired or already this owner's. Each acquisition increments
 * the fence. Throws `instance_locked` while another owner holds an unexpired lease. A heartbeat renews it every
 * `ttlMs / 3` until `release()`, which leaves no timer behind.
 */
export async function acquireLease(params: AcquireLeaseParams): Promise<Lease> {
  const { store, instanceId, ownerId, ttlMs, clock, sleep, onLost } = params;
  const stored = await store.get<LeaseRecord>(LEASES_COLLECTION, instanceId);
  const current = stored?.value;
  if (current != null && current.ownerId !== ownerId && current.expiresAt > clock.now()) throw locked({ instanceId, current });
  const fence = (current?.fence ?? 0) + 1;
  const taken = await store.compareAndSet<LeaseRecord>({ collection: LEASES_COLLECTION, key: instanceId, expectedVersion: stored?.version, value: { instanceId, ownerId, fence, expiresAt: clock.now() + ttlMs } });
  if (!taken) {
    const winner = (await store.get<LeaseRecord>(LEASES_COLLECTION, instanceId))?.value;
    throw winner == null ? fenced({ instanceId, fence }) : locked({ instanceId, current: winner });
  }

  async function update(expiresAt: number): Promise<void> {
    const latest = await store.get<LeaseRecord>(LEASES_COLLECTION, instanceId);
    if (latest?.value.ownerId !== ownerId || latest.value.fence !== fence) throw fenced({ instanceId, fence, ...(latest == null ? {} : { current: latest.value }) });
    const isWritten = await store.compareAndSet<LeaseRecord>({ collection: LEASES_COLLECTION, key: instanceId, expectedVersion: latest.version, value: { ...latest.value, expiresAt } });
    if (!isWritten) throw fenced({ instanceId, fence });
  }

  const stopped = new AbortController();
  const intervalMs = Math.max(1, Math.floor(ttlMs / HEARTBEATS_PER_TTL));
  const retryMs = Math.max(1, Math.floor(ttlMs / RETRIES_PER_TTL));
  let expiresAt = clock.now() + ttlMs;
  const heartbeat = (async () => {
    let delayMs = intervalMs;
    while (!stopped.signal.aborted) {
      await sleep(delayMs, stopped.signal);
      if (stopped.signal.aborted) return;
      const renewedTo = clock.now() + ttlMs;
      try {
        await update(renewedTo);
        expiresAt = renewedTo;
        delayMs = intervalMs;
      } catch (error) {
        // Taken over: lost at once. Anything else (a store blip) is retried until the lease would have expired.
        if (isFenced(error)) { onLost?.(error); return; }
        if (clock.now() >= expiresAt) { onLost?.(expired({ instanceId, fence, expiresAt, cause: error })); return; }
        delayMs = retryMs;
      }
    }
  })();

  return {
    fence,
    ownerId,
    renew: () => update(clock.now() + ttlMs),
    release: async () => {
      if (stopped.signal.aborted) return;
      stopped.abort();
      await heartbeat;
      // A lease already taken over is not ours to expire.
      await update(clock.now()).catch(() => undefined);
    },
  };
}
