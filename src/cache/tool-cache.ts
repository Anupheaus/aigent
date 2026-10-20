import type { Store } from '../store/store-types.js';
import { updateRecord } from '../store/update-record.js';
import type { WriteQueue } from '../store/write-queue.js';
import { isCacheable } from './is-cacheable.js';
import { buildEntry, evictedEntry, isCacheEntry, isInvalidation, isServable } from './cache-entry.js';
import type { EntryAddress } from './cache-entry.js';
import { findCacheFindings } from './cache-findings.js';
import { createCacheIndex } from './cache-index.js';
import { computeCacheKey } from './cache-key.js';
import { resolveCacheOptions } from './cache-options.js';
import { withHit, withMiss } from './cache-stats.js';
import { TOOL_CACHE_COLLECTION } from './cache-types.js';
import type { CacheEntry, CacheHit, CacheLookup, CacheOptions, CacheStore, ToolCache } from './cache-types.js';
import { createSingleFlight } from './single-flight.js';
import type { FlightOutcome } from './single-flight.js';

export interface CreateToolCacheParams {
  /** Where entries live (the runtime store, or a private in-memory store). */
  store: Store;
  /** Every entry update runs in this queue, keyed by the entry's store key, so statistics are exact. */
  writeQueue: WriteQueue;
  now(): number;
  options?: CacheOptions;
}

/** A lookup that missed and now owns (or merely precedes) the call's store. */
interface PendingStore extends EntryAddress {
  settle?(outcome: FlightOutcome): void;
  /** The lookup already counted its miss on an existing entry. */
  isMissCounted: boolean;
}

type Decision = { isHit: true; entry: CacheEntry } | { isHit: false; isMissCounted: boolean };

const GLOBAL_NAMESPACE = 'global';

/**
 * Non-deterministic results stay private to the instance (and definition) that produced them. Deterministic ones are
 * shared within the requesting agent's namespace by default, so two agents whose same-named tools are bound to
 * different data never see each other's results; `cacheNamespace` or `sharedCache` widen that explicitly.
 */
function namespaceOf(request: CacheLookup): string {
  const { tool: { deterministic, cacheNamespace, sharedCache, version }, context: { agentName, instanceId } } = request;
  if (!deterministic) return `instance:${instanceId}`;
  if (cacheNamespace != null) return `ns:${cacheNamespace}`;
  if (sharedCache === true) return GLOBAL_NAMESPACE;
  return `agent:${agentName}:${version ?? ''}`;
}

/**
 * The validity token is kept on the entry rather than in its key, so a changed token finds (and replaces) the stale
 * entry and is counted as an invalidation instead of leaving it behind under an orphaned key.
 */
async function addressOf(request: CacheLookup): Promise<EntryAddress> {
  const { tool, args, context } = request;
  const validity = tool.validity == null ? undefined : await tool.validity(args, context);
  const namespace = namespaceOf(request);
  const cacheKey = computeCacheKey({ tool, args, isDefinitionScoped: !tool.deterministic });
  return { namespace, storeKey: `${namespace}:${cacheKey}`, ...(validity == null ? {} : { validity }) };
}

/** Tool-result cache over a store: single-flight lookups, exact statistics, TTL, validity tokens and LRU eviction. */
export function createToolCache(params: CreateToolCacheParams): ToolCache {
  const { store, writeQueue, now } = params;
  const limits = resolveCacheOptions(params.options);
  const flights = createSingleFlight();
  const pending = new WeakMap<CacheLookup, PendingStore>();
  const index = createCacheIndex(limits);
  let indexLoaded: Promise<void> | undefined;

  async function loadIndex(): Promise<void> {
    for (const { key, value } of await store.list<unknown>(TOOL_CACHE_COLLECTION)) {
      if (isCacheEntry(value) && value.evicted !== true) index.touch(key, { bytes: value.bytes, lastRequestedAt: value.stats.lastRequestedAt });
    }
  }

  /** Read-modify-write of one entry inside its queue; `update` sees the stored entry. */
  function updateEntry(storeKey: string, update: (current: CacheEntry | undefined) => CacheEntry): Promise<CacheEntry> {
    return writeQueue.enqueue(storeKey, () => updateRecord<CacheEntry>({ store, collection: TOOL_CACHE_COLLECTION, key: storeKey, update }));
  }

  /** Decides hit or miss and records it on the entry, atomically per key. */
  async function evaluate(evaluation: { address: EntryAddress; agentName: string }): Promise<Decision> {
    const { address: { storeKey, validity }, agentName } = evaluation;
    const stored = await store.get<CacheEntry>(TOOL_CACHE_COLLECTION, storeKey);
    if (stored == null) return { isHit: false, isMissCounted: false };
    // Asserted so the narrowing of the initial value does not hide the assignments made inside the update.
    let decision = { isHit: false, isMissCounted: true } as Decision;
    await updateEntry(storeKey, current => {
      const entry = current ?? stored.value;
      const at = now();
      if (isServable({ entry, validity, now: at })) {
        const hitEntry = { ...entry, stats: withHit(entry.stats, { agentName, now: at, savedMs: entry.originalDurationMs, savedTokens: entry.resultTokens }) };
        decision = { isHit: true, entry: hitEntry };
        return hitEntry;
      }
      decision = { isHit: false, isMissCounted: true };
      return { ...entry, stats: withMiss(entry.stats, { agentName, isInvalidation: isInvalidation({ entry, validity, now: at }) }) };
    });
    if (decision.isHit) index.touch(storeKey, { bytes: decision.entry.bytes, lastRequestedAt: decision.entry.stats.lastRequestedAt });
    return decision;
  }

  async function lookup(request: CacheLookup): Promise<CacheHit | undefined> {
    if (!isCacheable(request.tool)) return undefined;
    let address: EntryAddress;
    try {
      address = await addressOf(request);
    } catch { // a failing cacheKey or validity only costs the cache: the call runs uncached
      return undefined;
    }
    indexLoaded ??= loadIndex();
    await indexLoaded;
    for (;;) {
      const claim = flights.claim(address.storeKey);
      if (!claim.isOwner) {
        // The first caller's result is stored now (loop to read it) or it failed (run the call ourselves).
        if (await claim.outcome === 'stored') continue;
        pending.set(request, { ...address, isMissCounted: false });
        return undefined;
      }
      let decision: Decision;
      try {
        decision = await evaluate({ address, agentName: request.context.agentName });
      } catch { // a store failure must not strand the callers waiting on this flight: they run the call themselves
        claim.settle('abandoned');
        return undefined;
      }
      if (decision.isHit) {
        claim.settle('stored');
        const { entry: { value, originalDurationMs } } = decision;
        return { value: structuredClone(value), key: address.storeKey, savedMs: originalDurationMs };
      }
      pending.set(request, { ...address, settle: claim.settle, isMissCounted: decision.isMissCounted });
      return undefined;
    }
  }

  async function evictOverflow(keep: string): Promise<void> {
    for (const storeKey of index.overflow(keep)) {
      index.remove(storeKey);
      await updateEntry(storeKey, current => evictedEntry(current as CacheEntry));
    }
  }

  async function storeResult(request: CacheStore): Promise<void> {
    const entryPending = pending.get(request.lookup);
    if (entryPending == null) return;
    pending.delete(request.lookup);
    const { settle, isMissCounted, ...address } = entryPending;
    try {
      if (request.bytes > limits.maxEntryBytes) { settle?.('abandoned'); return; }
      const copied = { ...request, value: structuredClone(request.value) };
      const stored = await updateEntry(address.storeKey, current => buildEntry({ current, address, request: copied, isMissCounted, now: now() }));
      index.touch(address.storeKey, { bytes: stored.bytes, lastRequestedAt: stored.stats.lastRequestedAt });
      settle?.('stored');
      await evictOverflow(address.storeKey);
    } catch { // a result the store cannot hold (or a store failure) is simply not cached
      settle?.('abandoned');
    }
  }

  function abandon(request: CacheLookup): void {
    const entryPending = pending.get(request);
    pending.delete(request);
    entryPending?.settle?.('abandoned');
  }

  async function findings(): ReturnType<ToolCache['findings']> {
    const records = await store.list<unknown>(TOOL_CACHE_COLLECTION);
    return findCacheFindings(records.flatMap(({ key, value }) => (isCacheEntry(value) ? [{ key, value }] : [])));
  }

  return { lookup, store: storeResult, abandon, findings };
}
