import type { CacheEntryStats } from './cache-types.js';

export interface FirstStatsParams {
  agentName: string;
  runId: string;
  now: number;
}

export interface HitEvent {
  agentName: string;
  now: number;
  /** The original call's duration. */
  savedMs: number;
  /** The result's estimated tokens. */
  savedTokens: number;
}

export interface MissEvent {
  agentName: string;
  /** The entry existed but its validity token changed. */
  isInvalidation: boolean;
}

function increment(counts: Record<string, number>, key: string): Record<string, number> {
  return { ...counts, [key]: (counts[key] ?? 0) + 1 };
}

/** Statistics of a newly stored entry: the miss that led to storing it is its first lookup. */
export function firstStats(params: FirstStatsParams): CacheEntryStats {
  const { agentName, runId, now } = params;
  return {
    firstStoredBy: { agentName, runId }, totalHits: 0, hitsByAgent: {}, missesByAgent: { [agentName]: 1 }, lastRequestedAt: now,
    missCount: 1, invalidationCount: 0, savedMs: 0, savedTokens: 0,
  };
}

/** A copy of `stats` with one more hit. */
export function withHit(stats: CacheEntryStats, hit: HitEvent): CacheEntryStats {
  const { agentName, now, savedMs, savedTokens } = hit;
  return {
    ...stats,
    totalHits: stats.totalHits + 1,
    hitsByAgent: increment(stats.hitsByAgent, agentName),
    lastRequestedAt: now,
    savedMs: stats.savedMs + savedMs,
    savedTokens: stats.savedTokens + savedTokens,
  };
}

/** A copy of `stats` with one more miss (and invalidation). */
export function withMiss(stats: CacheEntryStats, miss: MissEvent): CacheEntryStats {
  const { agentName, isInvalidation } = miss;
  return {
    ...stats,
    missCount: stats.missCount + 1,
    missesByAgent: increment(stats.missesByAgent, agentName),
    invalidationCount: stats.invalidationCount + (isInvalidation ? 1 : 0),
  };
}

function addCounts(left: Record<string, number>, right: Record<string, number>): Record<string, number> {
  const sums = { ...left };
  for (const [key, count] of Object.entries(right)) sums[key] = (sums[key] ?? 0) + count;
  return sums;
}

/** `into` with every counter of `from` added, for folding a deleted entry into its tool's summary. */
export function mergeStats(into: CacheEntryStats, from: CacheEntryStats): CacheEntryStats {
  return {
    firstStoredBy: into.firstStoredBy,
    totalHits: into.totalHits + from.totalHits,
    hitsByAgent: addCounts(into.hitsByAgent, from.hitsByAgent),
    missesByAgent: addCounts(into.missesByAgent, from.missesByAgent),
    lastRequestedAt: Math.max(into.lastRequestedAt, from.lastRequestedAt),
    missCount: into.missCount + from.missCount,
    invalidationCount: into.invalidationCount + from.invalidationCount,
    savedMs: into.savedMs + from.savedMs,
    savedTokens: into.savedTokens + from.savedTokens,
  };
}
