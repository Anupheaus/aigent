import type { Tool, ToolContext } from '../tools/tool-types.js';

/** Store collection holding tool-result cache entries, keyed `${namespace}:${cacheKey}`. */
export const TOOL_CACHE_COLLECTION = 'toolcache';

/** Version of the stored cache entry shape; bumped on any incompatible change. */
export const CACHE_ENTRY_SCHEMA_VERSION = 1;

/** `createAigent({ cache })`: limits of the tool-result cache. Every field is optional. */
export interface CacheOptions {
  /** Live entries kept before the least recently requested are evicted. Default 1000. */
  maxEntries?: number;
  /** Total bytes of live entries kept before the least recently requested are evicted. Default 64 MiB. */
  maxBytes?: number;
  /** Results larger than this (serialised UTF-8 bytes) are never cached. Default 256 KiB. */
  maxEntryBytes?: number;
}

/** Usage statistics of one cache entry; they survive replacement of a stale entry and eviction. */
export interface CacheEntryStats {
  /** Who stored the entry first. */
  firstStoredBy: { agentName: string; runId: string };
  totalHits: number;
  hitsByAgent: Record<string, number>;
  /** Misses that led to (re)storing this entry, by requesting agent. */
  missesByAgent: Record<string, number>;
  /** Epoch ms of the latest hit or store; eviction removes the least recent first. */
  lastRequestedAt: number;
  missCount: number;
  /** Misses caused by a changed validity token. */
  invalidationCount: number;
  /** Tool time saved by hits, in ms (the original run's duration per hit). */
  savedMs: number;
  /** Estimated result tokens served from the cache instead of being recomputed. */
  savedTokens: number;
}

/** One stored cache entry (`toolcache/<namespace>:<cacheKey>`). */
export interface CacheEntry {
  schemaVersion: typeof CACHE_ENTRY_SCHEMA_VERSION;
  /**
   * Deterministic tools: `agent:<agentName>:<version>` by default, `ns:<cacheNamespace>` or `global` (`sharedCache`) when
   * the tool opts in. Otherwise `instance:<instanceId>`, with the tool's definition id in the key.
   */
  namespace: string;
  /** Tool name. */
  tool: string;
  /** Epoch ms. */
  storedAt: number;
  /** Epoch ms after which the entry is not served (the tool's `cacheTtlMs`). */
  expiresAt?: number;
  /** The tool's validity token when the entry was stored. */
  validity?: string;
  /** The full, untruncated result (null once evicted). */
  value: unknown;
  /** Serialised UTF-8 bytes of `value` (0 once evicted). */
  bytes: number;
  /** How long the original call took, in ms. */
  originalDurationMs: number;
  /** Estimated tokens of the result. */
  resultTokens: number;
  /** Set when the entry was evicted; its statistics are kept for findings. */
  evicted?: boolean;
  stats: CacheEntryStats;
}

/** A cache lookup for one validated call; pass the same object to `store` or `abandon` afterwards. */
export interface CacheLookup {
  tool: Tool;
  /** Validated arguments (feedback fields already stripped, aliases already expanded). */
  args: unknown;
  context: ToolContext;
}

export interface CacheHit {
  /** A deep copy of the cached result. */
  value: unknown;
  /** The entry's store key, `${namespace}:${cacheKey}`. */
  key: string;
  /** Duration of the original call, now saved. */
  savedMs: number;
}

export interface CacheStore {
  /** The lookup that missed. */
  lookup: CacheLookup;
  /** The full, untruncated successful result. */
  value: unknown;
  durationMs: number;
  /** Serialised UTF-8 bytes of `value`. */
  bytes: number;
  resultTokens: number;
}

/** One hot entry in `CacheFindings.hottest`. */
export interface HotCacheEntry {
  tool: string;
  /** Store key `${namespace}:${cacheKey}`. */
  key: string;
  hits: number;
  savedMs: number;
}

/** A tool called repeatedly with identical arguments without being cached. */
export interface DeterministicCandidate {
  tool: string;
  /** Calls in groups of three or more identical calls within one run, summed over runs. */
  repeatedIdenticalCalls: number;
}

/** A cached tool whose entries are often invalidated by a changed validity token. */
export interface FrequentInvalidation {
  tool: string;
  invalidations: number;
  lookups: number;
}

/** What the tool-result cache found, surfaced as `Report.cache`. */
export interface CacheFindings {
  /** Entries with the most hits, most first (at most 10). */
  hottest: HotCacheEntry[];
  /** Hits / lookups per tool, 0 to 1. */
  hitRateByTool: Record<string, number>;
  /** Hits / lookups per requesting agent, 0 to 1. */
  hitRateByAgent: Record<string, number>;
  /** From traces: uncached tools called three or more times with identical arguments in one run, in two or more runs. */
  worthMarkingDeterministic: DeterministicCandidate[];
  frequentlyInvalidated: FrequentInvalidation[];
}

/** The tool-result cache: lookup before a call runs, store after it succeeded. */
export interface ToolCache {
  /**
   * A hit (deep copy, statistics updated) or undefined on a miss. A miss makes the caller the one that runs the call:
   * identical concurrent lookups wait for it (single-flight), so it must call `store` or `abandon` with the same lookup.
   */
  lookup(request: CacheLookup): Promise<CacheHit | undefined>;
  /** Stores a successful result (deep copy) unless it is too large; releases waiting lookups. */
  store(request: CacheStore): Promise<void>;
  /** The call that missed failed or was not cacheable: releases waiting lookups, which then run the call themselves. */
  abandon(request: CacheLookup): void;
  /** Findings over the stored entries (`worthMarkingDeterministic` needs traces and is filled by `ai.report()`). */
  findings(): Promise<CacheFindings>;
}
