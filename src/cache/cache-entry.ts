import { firstStats, withMiss } from './cache-stats.js';
import { CACHE_ENTRY_SCHEMA_VERSION } from './cache-types.js';
import type { CacheEntry, CacheStore } from './cache-types.js';

/** Where a lookup's entry lives and the validity token it was computed with. */
export interface EntryAddress {
  namespace: string;
  /** `${namespace}:${cacheKey}`. */
  storeKey: string;
  validity?: string;
}

export interface BuildEntryParams {
  /** The stored entry it replaces (stale, expired or evicted), whose statistics carry over. */
  current: CacheEntry | undefined;
  address: EntryAddress;
  /** The store request, with `value` already deep-copied. */
  request: CacheStore;
  /** True when the lookup already counted its miss on `current`. */
  isMissCounted: boolean;
  now: number;
}

/** A new entry; statistics carry over from the entry it replaces so invalidations and hits stay cumulative. */
export function buildEntry(params: BuildEntryParams): CacheEntry {
  const { current, address: { namespace, validity }, request, isMissCounted, now } = params;
  const { lookup: { tool, context: { agentName, runId } }, value, durationMs, bytes, resultTokens } = request;
  const { cacheTtlMs } = tool;
  const carried = current == null ? firstStats({ agentName, runId, now }) : current.stats;
  const counted = current != null && !isMissCounted ? withMiss(carried, { agentName, isInvalidation: false }) : carried;
  return {
    schemaVersion: CACHE_ENTRY_SCHEMA_VERSION, namespace, tool: tool.name, storedAt: now,
    ...(cacheTtlMs == null ? {} : { expiresAt: now + cacheTtlMs }),
    ...(validity == null ? {} : { validity }),
    value, bytes, originalDurationMs: durationMs, resultTokens,
    stats: { ...counted, lastRequestedAt: now },
  };
}

/** The entry with its value dropped and its statistics kept, so findings still see its history. */
export function evictedEntry(entry: CacheEntry): CacheEntry {
  return { ...entry, value: null, bytes: 0, evicted: true };
}

/** Whether `entry` can be served for a lookup with `validity` at `now`. */
export function isServable(params: { entry: CacheEntry; validity: string | undefined; now: number }): boolean {
  const { entry: { evicted, expiresAt, validity: storedValidity }, validity, now } = params;
  return evicted !== true && (expiresAt == null || now < expiresAt) && storedValidity === validity;
}

/** A miss on a live, unexpired entry whose validity token changed. */
export function isInvalidation(params: { entry: CacheEntry; validity: string | undefined; now: number }): boolean {
  const { entry: { evicted, expiresAt, validity: storedValidity }, validity, now } = params;
  return evicted !== true && (expiresAt == null || now < expiresAt) && storedValidity !== validity;
}

/** Loose shape check for stored entries (another runtime or an old version may have written them). */
export function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const { tool, stats } = value as Partial<CacheEntry>;
  return typeof tool === 'string' && typeof stats === 'object' && stats !== null && typeof stats.totalHits === 'number';
}
