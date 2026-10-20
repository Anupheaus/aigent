import { describe, expect, it } from 'vitest';
import { firstStats, withHit, withMiss } from './cache-stats.js';

describe('cache stats', () => {
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
