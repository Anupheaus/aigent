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
  /** Set when the consumer redacts what is stored. */
  isRedacted: boolean;
  /** `retention.expiresInMs`: entries in the consumer's store expire (and stop being served) this long after they were recorded. */
  expiresInMs?: number;
  writeQueue: WriteQueue;
  clock: Clock;
}

/**
 * The runtime's cache. It uses the consumer's store only when content may be stored there unredacted: with no store,
 * `captureContent: false` or a `redact` hook it lives in a private in-memory store instead, because redacting a
 * cached result would serve altered data back, and storing it unredacted would bypass the hook. In the consumer's
 * store entries carry `agentName`, `runId` and `recordedAt` (so `purge` reaches them) and honour retention.
 */
export function resolveToolCache(params: ResolveToolCacheParams): ToolCache | undefined {
  const { cache, store, captureContent, isRedacted, expiresInMs, writeQueue, clock } = params;
  if (cache === false) return undefined;
  const isConsumerStore = store != null && captureContent && !isRedacted;
  return createToolCache({
    store: isConsumerStore ? store : createInMemoryStore(), writeQueue, now: () => clock.now(),
    ...(cache == null ? {} : { options: cache }),
    ...(isConsumerStore && expiresInMs != null ? { expiresInMs } : {}),
  });
}
