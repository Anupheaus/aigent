import { createAigentError } from '../core/aigent-error.js';
import type { Store } from '../store/store-types.js';
import { LEASES_COLLECTION } from './checkpoint-types.js';
import type { LeaseRecord } from './lease.js';

export interface CreateFencedStoreParams {
  store: Store;
  instanceId: string;
  /** The writer's fence (from its lease); read at every write, so a renewed lease needs no new wrapper. */
  fence(): number;
}

async function checkFence(params: CreateFencedStoreParams & { collection: string; key: string }): Promise<void> {
  const { store, instanceId, fence, collection, key } = params;
  const lease = await store.get<LeaseRecord>(LEASES_COLLECTION, instanceId);
  const current = lease?.value.fence ?? 0;
  if (current <= fence()) return;
  throw createAigentError({
    code: 'store_conflict',
    message: `Write to '${collection}/${key}' rejected: instance '${instanceId}' was taken over (lease fence ${current}, this writer holds ${fence()})`,
    details: { fenced: true, instanceId, collection, key, fence: fence(), currentFence: current },
  });
}

/**
 * The store as one lease holder writes to it: a write from a writer whose fence is older than the stored lease's
 * (another process took the instance over) is rejected with `store_conflict` (`details.fenced: true`). Reads pass through.
 */
export function createFencedStore(params: CreateFencedStoreParams): Store {
  const { store } = params;
  const fenced: Store = {
    get: (collection, key) => store.get(collection, key),
    list: collection => store.list(collection),
    compareAndSet: async write => {
      await checkFence({ ...params, collection: write.collection, key: write.key });
      return store.compareAndSet(write);
    },
  };
  const { delete: deleteRecord, purge } = store;
  if (deleteRecord != null) {
    fenced.delete = async (collection, key) => {
      await checkFence({ ...params, collection, key });
      return deleteRecord.call(store, collection, key);
    };
  }
  if (purge != null) fenced.purge = filter => purge.call(store, filter);
  return fenced;
}
