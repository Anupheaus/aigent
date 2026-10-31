import type { MemoryEntry } from './memory-types.js';

const DAY_MS = 86_400_000;
/** How much the log of an entry's use count adds to its weight: three uses add about 69%. */
const USE_WEIGHT = 0.5;

export interface DecayFactorParams {
  /** Time since the entry was last updated or used; negative ages (clock skew) count as zero. */
  ageMs: number;
  halfLifeDays: number;
}

/** 1 for a fresh entry, halving every `halfLifeDays`. */
export function decayFactor(params: DecayFactorParams): number {
  const { ageMs, halfLifeDays } = params;
  return 0.5 ** (Math.max(0, ageMs) / DAY_MS / halfLifeDays);
}

export interface RetentionScoreParams {
  entry: MemoryEntry;
  now: number;
  halfLifeDays: number;
}

/** Time since the entry last mattered: its last use, else its last update. */
export function entryAgeMs(params: { entry: MemoryEntry; now: number }): number {
  const { entry: { lastUsedAt, updatedAt }, now } = params;
  return now - (lastUsedAt ?? updatedAt);
}

/** `confidence × decay(age) × (1 + 0.5·ln(1 + uses))`: what the cap keeps, highest first. */
export function retentionScore(params: RetentionScoreParams): number {
  const { entry, now, halfLifeDays } = params;
  const decay = decayFactor({ ageMs: entryAgeMs({ entry, now }), halfLifeDays });
  return entry.confidence * decay * (1 + USE_WEIGHT * Math.log1p(entry.uses));
}

export interface PickEvictionsParams {
  /** The live entries of one agent and scope. */
  entries: MemoryEntry[];
  maxEntries: number;
  now: number;
  halfLifeDays: number;
}

export interface Evictions {
  /** Every unpinned entry before any pinned one; within each, lowest score first. */
  evict: MemoryEntry[];
}

/**
 * The entries to evict to bring the set within `maxEntries`. Pinned entries count against the cap like any other
 * (so the cap always holds), but go only after every unpinned one. Within each group: lowest score, then oldest
 * update, then id.
 */
export function pickEvictions(params: PickEvictionsParams): Evictions {
  const { entries, maxEntries, now, halfLifeDays } = params;
  const excess = entries.length - maxEntries;
  if (excess <= 0) return { evict: [] };
  const ranked = entries
    .map(entry => ({ entry, score: retentionScore({ entry, now, halfLifeDays }) }))
    .sort((left, right) => Number(left.entry.pinned) - Number(right.entry.pinned)
      || left.score - right.score || left.entry.updatedAt - right.entry.updatedAt || (left.entry.id < right.entry.id ? -1 : 1));
  return { evict: ranked.slice(0, excess).map(({ entry }) => entry) };
}
