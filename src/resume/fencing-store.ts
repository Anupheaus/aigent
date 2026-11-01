import { createAigentError } from '../core/aigent-error.js';
import type { CompareAndSetParams, Store, StoredRecord } from '../store/store-types.js';
import { LEASES_COLLECTION } from './checkpoint-types.js';
import type { LeaseRecord } from './lease.js';

export interface CreateFencedStoreParams {
  store: Store;
  instanceId: string;
  /** The writer's fence (from its lease); read at every write, so a renewed lease needs no new wrapper. */
  fence(): number;
}

/** The fields the fenced store adds to every record it writes. */
interface FenceFields {
  /** The lease fence of the owner that wrote the record. */
  leaseFence?: number;
  /** A deleted record: kept as a fenced tombstone so a stale owner's delete can never remove a newer owner's record. */
  isDeleted?: boolean;
}

/** Attempts at replacing a record an older owner wrote; each failure means another write to the key landed first. */
const MAX_REPLACE_ATTEMPTS = 5;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fenceOf(record: StoredRecord<unknown> | undefined): number {
  const value = record?.value;
  return isPlainObject(value) && typeof value.leaseFence === 'number' ? value.leaseFence : 0;
}

function isTombstone(record: StoredRecord<unknown> | undefined): boolean {
  return isPlainObject(record?.value) && (record.value as FenceFields).isDeleted === true;
}

function fencedError(params: { instanceId: string; collection: string; key: string; fence: number; currentFence: number }): Error {
  const { instanceId, collection, key, fence, currentFence } = params;
  return createAigentError({
    code: 'store_conflict',
    message: `Write to '${collection}/${key}' rejected: instance '${instanceId}' was taken over (fence ${currentFence}, this writer holds ${fence})`,
    details: { fenced: true, instanceId, collection, key, fence, currentFence },
  });
}

/**
 * The store as one lease holder writes to it. Every record carries the fence of the owner that wrote it
 * (`leaseFence`), and the fence is checked inside the same compare-and-set as the write: a record a newer owner wrote
 * is never replaced or deleted by an older one (`store_conflict`, `details.fenced: true`), whatever the interleaving.
 * The lease is also checked first, so a stale owner learns early. A record an older owner wrote does not block a newer
 * owner's create: it is replaced. Deletes leave a fenced tombstone, which reads through this store do not see.
 */
export function createFencedStore(params: CreateFencedStoreParams): Store {
  const { store, instanceId, fence } = params;

  async function checkLease(params: { collection: string; key: string }): Promise<number> {
    const held = fence();
    const lease = await store.get<LeaseRecord>(LEASES_COLLECTION, instanceId);
    const currentFence = lease?.value.fence ?? 0;
    if (currentFence > held) throw fencedError({ instanceId, ...params, fence: held, currentFence });
    return held;
  }

  /** Writes `value` stamped with the fence, atomically refusing (via the record's version) if a newer owner wrote first. */
  async function fencedWrite<T>(write: CompareAndSetParams<T> & { value: T & FenceFields }): Promise<boolean> {
    const { collection, key, expectedVersion } = write;
    const held = await checkLease({ collection, key });
    if (!isPlainObject(write.value)) throw createAigentError({ code: 'invalid_input', message: `Fenced records must be objects so they can carry their owner's fence; '${collection}/${key}' got ${typeof write.value}`, details: { collection, key } });
    const value = { ...write.value, leaseFence: held };
    for (let attempt = 1; attempt <= MAX_REPLACE_ATTEMPTS; attempt += 1) {
      const current = await store.get<unknown>(collection, key);
      const currentFence = fenceOf(current);
      if (current != null && currentFence > held) throw fencedError({ instanceId, collection, key, fence: held, currentFence });
      // A create meets a tombstone or an older owner's record: replace it, at the version just read (atomic).
      const isReplace = expectedVersion === undefined && current != null && (isTombstone(current) || currentFence < held);
      if (!isReplace) return store.compareAndSet({ collection, key, expectedVersion, value });
      if (await store.compareAndSet({ collection, key, expectedVersion: current.version, value })) return true;
    }
    return false;
  }

  const fenced: Store = {
    get: async (collection, key) => {
      const record = await store.get<unknown>(collection, key);
      return isTombstone(record) ? undefined : record as never;
    },
    list: async (collection, options) => (await store.list<unknown>(collection, options)).filter(record => !isTombstone(record)) as never,
    compareAndSet: write => fencedWrite(write as CompareAndSetParams<FenceFields>),
  };
  if (store.delete != null) {
    fenced.delete = async (collection, key) => {
      for (let attempt = 1; attempt <= MAX_REPLACE_ATTEMPTS; attempt += 1) {
        const current = await store.get<unknown>(collection, key);
        if (current == null || isTombstone(current)) return;
        if (await fencedWrite<FenceFields>({ collection, key, expectedVersion: current.version, value: { isDeleted: true } })) return;
      }
    };
  }
  const { purge } = store;
  if (purge != null) fenced.purge = filter => purge.call(store, filter);
  return fenced;
}
