import { createToolCache } from '../cache/tool-cache.js';
import type { CacheOptions, ToolCache } from '../cache/cache-types.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import type { WriteQueue } from '../store/write-queue.js';
import type { Clock } from './runtime-services.js';

interface ResolveToolCacheParams {
  cache: CacheOptions | false | undefined;
  store: Store | undefined;
  captureContent: boolean;
  writeQueue: WriteQueue;
  clock: Clock;
}

/** The runtime's cache, kept out of the consumer's store when there is none or content capture is off. */
export function resolveToolCache(params: ResolveToolCacheParams): ToolCache | undefined {
  const { cache, store, captureContent, writeQueue, clock } = params;
  if (cache === false) return undefined;
  const cacheStore = store != null && captureContent ? store : createInMemoryStore();
  return createToolCache({ store: cacheStore, writeQueue, now: () => clock.now(), ...(cache == null ? {} : { options: cache }) });
}
