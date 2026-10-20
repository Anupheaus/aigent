import type { TraceStep } from '../telemetry/run-record.js';
import { SUMMARY_NAMESPACE } from './cache-entry.js';
import type { CacheEntry, CacheFindings, DeterministicCandidate, FrequentInvalidation, HotCacheEntry } from './cache-types.js';

/** Longest `CacheFindings.hottest` list. */
const MAX_HOTTEST_ENTRIES = 10;
/** Invalidations a tool needs before it can be flagged. */
const MIN_INVALIDATIONS = 3;
/** Share of a tool's lookups that must be invalidations to flag it. */
const INVALIDATION_RATE_THRESHOLD = 0.25;
/** Identical calls within one run that count as worth caching. */
const MIN_IDENTICAL_CALLS = 3;
/** Runs that must show such repeats before a tool is flagged. */
const MIN_REPEATING_RUNS = 2;
/** Wrappers and commentary whose repeats say nothing about caching. */
const NON_WORK_TOOLS = new Set(['aigent_multi', 'aigent_feedback']);

/** A stored entry with its store key. */
export interface KeyedCacheEntry {
  key: string;
  value: CacheEntry;
}

/** A run's steps, as `findDeterministicCandidates` needs them. */
export interface StepsOfRun {
  steps: TraceStep[];
}

interface HitCounts {
  hits: number;
  lookups: number;
}

function addCounts(totals: Map<string, HitCounts>, params: { key: string; hits: number; misses: number }): void {
  const { key, hits, misses } = params;
  const current = totals.get(key) ?? { hits: 0, lookups: 0 };
  totals.set(key, { hits: current.hits + hits, lookups: current.lookups + hits + misses });
}

function toRates(totals: Map<string, HitCounts>): Record<string, number> {
  return Object.fromEntries([...totals.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, { hits, lookups }]) => [key, lookups === 0 ? 0 : hits / lookups]));
}

function hottest(entries: KeyedCacheEntry[]): HotCacheEntry[] {
  return entries
    // A tool's summary record (statistics of deleted entries) is not an entry anyone could hit.
    .filter(({ value }) => value.stats.totalHits > 0 && value.namespace !== SUMMARY_NAMESPACE)
    .map(({ key, value: { tool, stats: { totalHits, savedMs } } }) => ({ tool, key, hits: totalHits, savedMs }))
    .sort((left, right) => right.hits - left.hits || left.key.localeCompare(right.key))
    .slice(0, MAX_HOTTEST_ENTRIES);
}

function frequentlyInvalidated(entries: KeyedCacheEntry[]): FrequentInvalidation[] {
  const byTool = new Map<string, FrequentInvalidation>();
  for (const { value: { tool, stats: { totalHits, missCount, invalidationCount } } } of entries) {
    const current = byTool.get(tool) ?? { tool, invalidations: 0, lookups: 0 };
    byTool.set(tool, { tool, invalidations: current.invalidations + invalidationCount, lookups: current.lookups + totalHits + missCount });
  }
  return [...byTool.values()]
    .filter(({ invalidations, lookups }) => invalidations >= MIN_INVALIDATIONS && invalidations / lookups >= INVALIDATION_RATE_THRESHOLD)
    .sort((left, right) => right.invalidations - left.invalidations || left.tool.localeCompare(right.tool));
}

/** Findings over stored cache entries; evicted entries keep their statistics and still count. Pure. */
export function findCacheFindings(entries: KeyedCacheEntry[]): CacheFindings {
  const byTool = new Map<string, HitCounts>();
  const byAgent = new Map<string, HitCounts>();
  for (const { value: { tool, stats } } of entries) {
    addCounts(byTool, { key: tool, hits: stats.totalHits, misses: stats.missCount });
    const agents = new Set([...Object.keys(stats.hitsByAgent), ...Object.keys(stats.missesByAgent)]);
    for (const agentName of agents) addCounts(byAgent, { key: agentName, hits: stats.hitsByAgent[agentName] ?? 0, misses: stats.missesByAgent[agentName] ?? 0 });
  }
  return {
    hottest: hottest(entries),
    hitRateByTool: toRates(byTool),
    hitRateByAgent: toRates(byAgent),
    worthMarkingDeterministic: [],
    frequentlyInvalidated: frequentlyInvalidated(entries),
  };
}

/** Per tool, the calls in groups of `MIN_IDENTICAL_CALLS`+ identical calls of one run. Cached tools (steps with `cacheHit`) are skipped. */
function repeatsInRun(steps: TraceStep[]): Map<string, number> {
  const groups = new Map<string, { tool: string; calls: number }>();
  for (const { tool, argsHash, argsSummary, cacheHit } of steps) {
    if (cacheHit != null || NON_WORK_TOOLS.has(tool)) continue;
    // argsHash is salted per run, so equal hashes mean equal arguments within this run only.
    const groupKey = `${tool}\n${argsHash ?? argsSummary}`;
    const group = groups.get(groupKey) ?? { tool, calls: 0 };
    groups.set(groupKey, { tool, calls: group.calls + 1 });
  }
  const repeats = new Map<string, number>();
  for (const { tool, calls } of groups.values()) {
    if (calls >= MIN_IDENTICAL_CALLS) repeats.set(tool, (repeats.get(tool) ?? 0) + calls);
  }
  return repeats;
}

/**
 * Uncached tools called `MIN_IDENTICAL_CALLS`+ times with identical arguments within one run, in `MIN_REPEATING_RUNS`+
 * runs. Traces do not record whether a tool is deterministic, so every uncached tool is a candidate. Pure.
 */
export function findDeterministicCandidates(runs: StepsOfRun[]): DeterministicCandidate[] {
  const totals = new Map<string, { runs: number; calls: number }>();
  for (const { steps } of runs) {
    for (const [tool, calls] of repeatsInRun(steps)) {
      const current = totals.get(tool) ?? { runs: 0, calls: 0 };
      totals.set(tool, { runs: current.runs + 1, calls: current.calls + calls });
    }
  }
  return [...totals.entries()]
    .filter(([, { runs: repeatingRuns }]) => repeatingRuns >= MIN_REPEATING_RUNS)
    .map(([tool, { calls }]) => ({ tool, repeatedIdenticalCalls: calls }))
    .sort((left, right) => right.repeatedIdenticalCalls - left.repeatedIdenticalCalls || left.tool.localeCompare(right.tool));
}
