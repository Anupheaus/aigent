import { firstStats, mergeStats, withMiss } from './cache-stats.js';
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
  /** Retention: the entry expires this long after `now` at the latest. */
  expiresInMs?: number;
}

/** The earlier of the tool's TTL and retention, as an epoch ms; undefined when neither applies. */
function expiryOf(params: { now: number; cacheTtlMs: number | undefined; expiresInMs: number | undefined }): number | undefined {
  const { now, cacheTtlMs, expiresInMs } = params;
  const limits = [cacheTtlMs, expiresInMs].filter((limit): limit is number => limit != null);
  return limits.length === 0 ? undefined : now + Math.min(...limits);
}

/** A new entry; statistics carry over from the entry it replaces so invalidations and hits stay cumulative. */
export function buildEntry(params: BuildEntryParams): CacheEntry {
  const { current, address: { namespace, validity }, request, isMissCounted, now, expiresInMs } = params;
  const { lookup: { tool, context: { agentName, runId } }, value, durationMs, bytes, resultTokens } = request;
  const { cacheTtlMs } = tool;
  const carried = current == null ? firstStats({ agentName, runId, now }) : current.stats;
  const counted = current != null && !isMissCounted ? withMiss(carried, { agentName, isInvalidation: false }) : carried;
  const expiresAt = expiryOf({ now, cacheTtlMs, expiresInMs });
  return {
    schemaVersion: CACHE_ENTRY_SCHEMA_VERSION, namespace, tool: tool.name, storedAt: now,
    // Telemetry record fields, so purge({ agentName, runId, before }) reaches the entries a run stored.
    agentName, runId, recordedAt: now,
    ...(expiresAt == null ? {} : { expiresAt }),
    ...(validity == null ? {} : { validity }),
    value, bytes, originalDurationMs: durationMs, resultTokens,
    stats: { ...counted, lastRequestedAt: now },
  };
}

/** The entry with its value dropped and its statistics kept, so findings still see its history. */
export function evictedEntry(entry: CacheEntry): CacheEntry {
  return { ...entry, value: null, bytes: 0, evicted: true };
}

/** Namespace of the per-tool records that hold the statistics of deleted (evicted) entries. */
export const SUMMARY_NAMESPACE = 'summary';

/** Store key of a tool's summary record. */
export function summaryKey(tool: string): string {
  return `${SUMMARY_NAMESPACE}:${tool}`;
}

/**
 * The tool's summary record with a deleted entry's statistics added: one bounded record per tool, never served, so
 * findings (hit rates, invalidations) keep the history of entries that are gone.
 */
export function withEvictedStats(params: { summary: CacheEntry | undefined; evicted: CacheEntry; now: number }): CacheEntry {
  const { summary, evicted, now } = params;
  if (summary != null) return { ...summary, storedAt: now, stats: mergeStats(summary.stats, evicted.stats) };
  return {
    schemaVersion: CACHE_ENTRY_SCHEMA_VERSION, namespace: SUMMARY_NAMESPACE, tool: evicted.tool, storedAt: now,
    value: null, bytes: 0, originalDurationMs: 0, resultTokens: 0, evicted: true, stats: evicted.stats,
  };
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
