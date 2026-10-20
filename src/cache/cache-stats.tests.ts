import { describe, expect, it } from 'vitest';
import { firstStats, mergeStats, withHit, withMiss } from './cache-stats.js';

describe('cache stats', () => {
  it('merges every counter of a deleted entry into a summary, keeping the first storer of the summary', () => {
    const summary = withHit(firstStats({ agentName: 'a', runId: 'r1', now: 5 }), { agentName: 'a', now: 6, savedMs: 10, savedTokens: 2 });
    const evicted = withMiss(withHit(firstStats({ agentName: 'b', runId: 'r2', now: 7 }), { agentName: 'a', now: 9, savedMs: 4, savedTokens: 1 }), { agentName: 'b', isInvalidation: true });
    expect(mergeStats(summary, evicted)).toEqual({
      firstStoredBy: { agentName: 'a', runId: 'r1' }, totalHits: 2, hitsByAgent: { a: 2 }, missesByAgent: { a: 1, b: 2 }, lastRequestedAt: 9,
      missCount: 3, invalidationCount: 1, savedMs: 14, savedTokens: 3,
    });
  });

  it('starts with the miss that stored the entry', () => {
    expect(firstStats({ agentName: 'a', runId: 'r1', now: 5 })).toEqual({
      firstStoredBy: { agentName: 'a', runId: 'r1' }, totalHits: 0, hitsByAgent: {}, missesByAgent: { a: 1 }, lastRequestedAt: 5,
      missCount: 1, invalidationCount: 0, savedMs: 0, savedTokens: 0,
    });
  });

  it('counts a hit per agent and adds the saved time and tokens, without mutating the input', () => {
    const start = firstStats({ agentName: 'a', runId: 'r1', now: 5 });
    const once = withHit(start, { agentName: 'b', now: 9, savedMs: 40, savedTokens: 12 });
    const twice = withHit(once, { agentName: 'b', now: 11, savedMs: 40, savedTokens: 12 });
    expect(twice).toMatchObject({ totalHits: 2, hitsByAgent: { b: 2 }, lastRequestedAt: 11, savedMs: 80, savedTokens: 24 });
    expect(start.totalHits).toBe(0);
    expect(start.hitsByAgent).toEqual({});
  });

  it('counts misses per agent and invalidations separately', () => {
    const start = firstStats({ agentName: 'a', runId: 'r1', now: 5 });
    const stale = withMiss(start, { agentName: 'b', isInvalidation: true });
    const expired = withMiss(stale, { agentName: 'b', isInvalidation: false });
    expect(expired).toMatchObject({ missCount: 3, invalidationCount: 1, missesByAgent: { a: 1, b: 2 } });
  });
});
