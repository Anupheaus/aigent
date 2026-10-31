import { describe, expect, it } from 'vitest';
import { decayFactor, pickEvictions, retentionScore } from './decay.js';
import type { MemoryEntry } from './memory-types.js';

const DAY_MS = 86_400_000;
const NOW = 100 * DAY_MS;
const HALF_LIFE_DAYS = 30;

function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'm', agentName: 'helper', scopeKey: 'agent', kind: 'fact', text: 'x', tags: [], source: { runId: 'r', origin: 'tool-call' },
    confidence: 0.6, pinned: false, uses: 0, createdAt: NOW, updatedAt: NOW, recordedAt: NOW, ...overrides,
  };
}

describe('decayFactor', () => {
  it.each([
    [0, 1],
    [30, 0.5],
    [60, 0.25],
    [15, 0.7071],
    [-5, 1],
  ])('after %d days with a 30-day half-life is %d', (days, expected) => {
    expect(decayFactor({ ageMs: days * DAY_MS, halfLifeDays: HALF_LIFE_DAYS })).toBeCloseTo(expected, 4);
  });
});

describe('retentionScore', () => {
  it.each([
    ['fresh, unused', { confidence: 0.6 }, 0.6],
    ['30 days since update', { confidence: 0.6, updatedAt: NOW - 30 * DAY_MS }, 0.3],
    // 0.5 decay x (1 + 0.5 x ln 4) for three uses.
    ['30 days, used 3 times', { confidence: 1, updatedAt: NOW - 30 * DAY_MS, uses: 3 }, 0.8466],
    // Age counts from the last use when there is one.
    ['updated long ago but used today', { confidence: 0.6, updatedAt: NOW - 90 * DAY_MS, lastUsedAt: NOW }, 0.6],
  ])('%s', (_label, overrides, expected) => {
    expect(retentionScore({ entry: entry(overrides), now: NOW, halfLifeDays: HALF_LIFE_DAYS })).toBeCloseTo(expected, 4);
  });
});

describe('pickEvictions', () => {
  it('evicts nothing within the cap', () => {
    const entries = [entry({ id: 'a' }), entry({ id: 'b' })];
    expect(pickEvictions({ entries, maxEntries: 2, now: NOW, halfLifeDays: HALF_LIFE_DAYS })).toEqual({ evict: [], pinnedOverflow: 0 });
  });

  it('evicts the stale unused entries before the useful ones', () => {
    const entries = [
      entry({ id: 'useful', confidence: 0.8, uses: 5, lastUsedAt: NOW }),
      entry({ id: 'stale', confidence: 0.8, updatedAt: NOW - 120 * DAY_MS }),
      entry({ id: 'fresh', confidence: 0.6 }),
      entry({ id: 'doubtful', confidence: 0.3 }),
    ];
    const { evict } = pickEvictions({ entries, maxEntries: 2, now: NOW, halfLifeDays: HALF_LIFE_DAYS });
    expect(evict.map(({ id }) => id)).toEqual(['stale', 'doubtful']);
  });

  it('never evicts pinned entries and reports how far over the cap they leave it', () => {
    const entries = [entry({ id: 'p1', pinned: true, confidence: 0.1 }), entry({ id: 'p2', pinned: true, confidence: 0.1 }), entry({ id: 'u', confidence: 0.9 })];
    expect(pickEvictions({ entries, maxEntries: 1, now: NOW, halfLifeDays: HALF_LIFE_DAYS })).toEqual({ evict: [entries[2]], pinnedOverflow: 1 });
  });

  it('breaks score ties by the older update, then by id', () => {
    const entries = [entry({ id: 'b' }), entry({ id: 'a' }), entry({ id: 'c', updatedAt: NOW - 1 }), entry({ id: 'keep', confidence: 1 })];
    const { evict } = pickEvictions({ entries, maxEntries: 1, now: NOW, halfLifeDays: 1_000_000 });
    expect(evict.map(({ id }) => id)).toEqual(['c', 'a', 'b']);
  });
});
