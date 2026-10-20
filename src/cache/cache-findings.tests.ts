import { describe, expect, it } from 'vitest';
import type { TraceStep } from '../telemetry/run-record.js';
import { findCacheFindings, findDeterministicCandidates } from './cache-findings.js';
import type { CacheEntry, CacheEntryStats } from './cache-types.js';

function stats(overrides: Partial<CacheEntryStats>): CacheEntryStats {
  return {
    firstStoredBy: { agentName: 'a', runId: 'r' }, totalHits: 0, hitsByAgent: {}, missesByAgent: {}, lastRequestedAt: 0,
    missCount: 0, invalidationCount: 0, savedMs: 0, savedTokens: 0, ...overrides,
  };
}

function entry(params: { key: string; tool: string; stats: Partial<CacheEntryStats>; evicted?: boolean }): { key: string; value: CacheEntry } {
  const { key, tool, evicted } = params;
  return {
    key,
    value: {
      schemaVersion: 1, namespace: 'global', tool, storedAt: 0, value: evicted === true ? null : 'x', bytes: 3, originalDurationMs: 5, resultTokens: 1,
      ...(evicted === true ? { evicted } : {}), stats: stats(params.stats),
    },
  };
}

function step(params: { index: number; tool: string; argsHash: string; cacheHit?: boolean }): TraceStep {
  const { index, tool, argsHash, cacheHit } = params;
  return {
    index, turn: 1, callId: `c${index}`, tool, argsSummary: '{}', argsHash, ok: true, resultBytes: 1, resultTokens: 1, truncated: false, durationMs: 1, startedAtMs: 0,
    ...(cacheHit == null ? {} : { cacheHit }),
  };
}

/** `count` identical calls of `tool`, then one call with other arguments. */
function repeatedSteps(params: { tool: string; count: number; cacheHit?: boolean }): TraceStep[] {
  const { tool, count, cacheHit } = params;
  const repeats = Array.from({ length: count }, (_unused, index) => step({ index, tool, argsHash: 'same', ...(cacheHit == null ? {} : { cacheHit }) }));
  return [...repeats, step({ index: count, tool, argsHash: 'other' })];
}

describe('findCacheFindings', () => {
  it('ranks the hottest entries, evicted ones included, and caps the list at ten', () => {
    const entries = Array.from({ length: 12 }, (_unused, index) => entry({ key: `global:${index}`, tool: 'read', stats: { totalHits: index, savedMs: index * 10 } }));
    entries.push(entry({ key: 'global:gone', tool: 'read', stats: { totalHits: 50 }, evicted: true }));
    const { hottest } = findCacheFindings(entries);
    expect(hottest).toHaveLength(10);
    expect(hottest[0]).toEqual({ tool: 'read', key: 'global:gone', hits: 50, savedMs: 0 });
    expect(hottest[1]).toEqual({ tool: 'read', key: 'global:11', hits: 11, savedMs: 110 });
  });

  it('computes hit rates per tool and per agent from hits and misses', () => {
    const findings = findCacheFindings([
      entry({ key: 'global:1', tool: 'read', stats: { totalHits: 3, missCount: 1, hitsByAgent: { a: 3 }, missesByAgent: { b: 1 } } }),
      entry({ key: 'global:2', tool: 'search', stats: { totalHits: 0, missCount: 2, missesByAgent: { a: 2 } } }),
    ]);
    expect(findings.hitRateByTool).toEqual({ read: 0.75, search: 0 });
    expect(findings.hitRateByAgent).toEqual({ a: 0.6, b: 0 });
  });

  it('flags tools whose entries are invalidated often', () => {
    const findings = findCacheFindings([
      entry({ key: 'global:1', tool: 'read', stats: { totalHits: 1, missCount: 4, invalidationCount: 3 } }),
      entry({ key: 'global:2', tool: 'stable', stats: { totalHits: 20, missCount: 4, invalidationCount: 3 } }),
      entry({ key: 'global:3', tool: 'rare', stats: { totalHits: 0, missCount: 2, invalidationCount: 2 } }),
    ]);
    expect(findings.frequentlyInvalidated).toEqual([{ tool: 'read', invalidations: 3, lookups: 5 }]);
  });

  it('is empty without entries', () => {
    expect(findCacheFindings([])).toEqual({ hottest: [], hitRateByTool: {}, hitRateByAgent: {}, worthMarkingDeterministic: [], frequentlyInvalidated: [] });
  });
});

describe('findDeterministicCandidates', () => {
  it('flags uncached tools called three or more times with identical arguments in at least two runs', () => {
    const candidates = findDeterministicCandidates([
      { steps: repeatedSteps({ tool: 'lookup', count: 3 }) },
      { steps: repeatedSteps({ tool: 'lookup', count: 4 }) },
      { steps: repeatedSteps({ tool: 'once', count: 3 }) },
      { steps: repeatedSteps({ tool: 'twice', count: 2 }) },
      { steps: repeatedSteps({ tool: 'twice', count: 2 }) },
      { steps: repeatedSteps({ tool: 'cached', count: 3, cacheHit: true }) },
      { steps: repeatedSteps({ tool: 'cached', count: 3, cacheHit: false }) },
    ]);
    expect(candidates).toEqual([{ tool: 'lookup', repeatedIdenticalCalls: 7 }]);
  });

  it('ignores aigent_multi wrappers and inner calls of other tools stay counted', () => {
    const multi = repeatedSteps({ tool: 'aigent_multi', count: 3 });
    expect(findDeterministicCandidates([{ steps: multi }, { steps: multi }])).toEqual([]);
  });
});
