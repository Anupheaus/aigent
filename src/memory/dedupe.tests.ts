import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { memoryId, mergeMemory, normaliseMemoryText } from './dedupe.js';
import type { MemoryEntry } from './memory-types.js';

function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'm1', agentName: 'helper', scopeKey: 'agent', kind: 'fact', text: 'Tests live in src', tags: [], source: { runId: 'run_1', callId: 'c1', origin: 'tool-call' },
    confidence: 0.6, pinned: false, uses: 0, createdAt: 1_000, updatedAt: 1_000, recordedAt: 1_000, ...overrides,
  };
}

describe('normaliseMemoryText', () => {
  it.each([
    ['  Tests   live\nin SRC ', 'tests live in src'],
    ['Café', 'café'],
    ['\tA\t\tB', 'a b'],
  ])('%j becomes %j', (text, expected) => {
    expect(normaliseMemoryText(text)).toBe(expected);
  });
});

describe('memoryId', () => {
  const base = { agentName: 'helper', scopeKey: 'agent', kind: 'fact' as const, text: 'Tests live in src' };

  it('is the sha-256 of agent, scope, kind and normalised text', () => {
    const expected = createHash('sha256').update(JSON.stringify(['helper', 'agent', 'fact', 'tests live in src'])).digest('hex');
    expect(memoryId(base)).toBe(expected);
  });

  it('lands case and spacing variants on the same id', () => {
    expect(memoryId({ ...base, text: '  TESTS live  in src' })).toBe(memoryId(base));
  });

  it.each([
    [{ agentName: 'other' }],
    [{ scopeKey: 'session:s1' }],
    [{ kind: 'lesson' as const }],
    [{ text: 'Tests live in lib' }],
  ])('differs when %j differs', overrides => {
    expect(memoryId({ ...base, ...overrides })).not.toBe(memoryId(base));
  });

  it('cannot be confused by separators inside the parts', () => {
    expect(memoryId({ ...base, agentName: 'a', scopeKey: 'b c' })).not.toBe(memoryId({ ...base, agentName: 'a b', scopeKey: 'c' }));
  });
});

describe('mergeMemory', () => {
  const NOW = 9_000;

  it('takes the incoming text and source when it is more confident, and raises confidence by 0.1', () => {
    const current = entry({ confidence: 0.6, text: 'tests live in src' });
    const incoming = entry({ confidence: 0.8, text: 'Tests live in src', source: { runId: 'run_2', origin: 'user-correction' }, createdAt: NOW, updatedAt: NOW, recordedAt: NOW });
    expect(mergeMemory({ current, incoming, now: NOW })).toEqual(entry({
      confidence: 0.9, text: 'Tests live in src', source: { runId: 'run_2', origin: 'user-correction' }, createdAt: 1_000, updatedAt: NOW, recordedAt: NOW,
    }));
  });

  it('keeps the stored text and source when it is more confident', () => {
    const current = entry({ confidence: 0.9, text: 'Tests live in src' });
    const incoming = entry({ confidence: 0.6, text: 'tests  live in src!', source: { runId: 'run_2', callId: 'c9', origin: 'tool-call' }, createdAt: NOW });
    const merged = mergeMemory({ current, incoming, now: NOW });
    expect(merged.text).toBe('Tests live in src');
    expect(merged.source).toEqual({ runId: 'run_1', callId: 'c1', origin: 'tool-call' });
    expect(merged.confidence).toBe(1);
  });

  it('prefers the longer text on equal confidence', () => {
    const merged = mergeMemory({ current: entry({ text: 'tests live in src' }), incoming: entry({ text: 'Tests live in src.', source: { runId: 'run_3', origin: 'tool-call' } }), now: NOW });
    expect(merged.text).toBe('Tests live in src.');
    expect(merged.source.runId).toBe('run_3');
    expect(merged.confidence).toBe(0.7);
  });

  it('unions tags (stored first, at most 5), keeps pinned, uses and the earliest createdAt', () => {
    const current = entry({ tags: ['a', 'b', 'c'], pinned: true, uses: 4, lastUsedAt: 2_000, createdAt: 500 });
    const incoming = entry({ tags: ['c', 'd', 'e', 'f'], pinned: false, createdAt: NOW });
    const merged = mergeMemory({ current, incoming, now: NOW });
    expect(merged.tags).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(merged.pinned).toBe(true);
    expect(merged.uses).toBe(4);
    expect(merged.lastUsedAt).toBe(2_000);
    expect(merged.createdAt).toBe(500);
  });

  it('pins an entry when the incoming note is pinned', () => {
    expect(mergeMemory({ current: entry({ pinned: false }), incoming: entry({ pinned: true }), now: NOW }).pinned).toBe(true);
  });

  it('never raises confidence above 1', () => {
    expect(mergeMemory({ current: entry({ confidence: 0.95 }), incoming: entry({ confidence: 0.6 }), now: NOW }).confidence).toBe(1);
  });

  it('replaces a tombstone with the incoming entry as new', () => {
    const current = entry({ removed: { at: 2_000, reason: 'forgotten' }, uses: 7, confidence: 0.9, createdAt: 500 });
    const incoming = entry({ text: 'Tests live in src', createdAt: NOW, updatedAt: NOW, recordedAt: NOW });
    expect(mergeMemory({ current, incoming, now: NOW })).toEqual(incoming);
  });
});
