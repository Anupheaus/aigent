import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCompaction } from './apply-compaction.js';
import type { CompactionChanges } from './apply-compaction.js';
import { cacheBreakpoints } from './cache-breakpoints.js';
import { DEFAULT_COMPACTION_POLICY } from './compaction-policy.js';
import { compactionGroups } from './compaction-groups.js';
import { historyBuilder, stateTokens } from './compaction.test-support.js';
import { createContextMessage } from './context-message.js';
import type { ContextMessage } from './context-message.js';
import { planCompaction } from './plan-compaction.js';
import { computePrefixHash } from './prefix-hash.js';
import { duplicateResultStub, toolResultStub } from './tool-result-stub.js';

const NO_CHANGES: CompactionChanges = { stubs: new Map(), dedupes: new Map(), summarise: [] };

function summaryMessage(text: string, seq = 900): ContextMessage {
  return createContextMessage({ runId: 'r', seq, kind: 'summary', createdAt: 0, message: { role: 'user', text } });
}

/** The plan applied with handles `H<n>` and a fixed summary text. */
function changesFor(plan: NonNullable<ReturnType<typeof planCompaction>>, summarySeq: number): CompactionChanges {
  return {
    stubs: new Map(plan.stubs.map(({ messageId, tool, callId, tokens }, index) => [messageId, { text: toolResultStub({ tool, callId, tokens, handle: `H${index + 1}` }), handle: `H${index + 1}` }])),
    dedupes: new Map(plan.dedupes.map(({ messageId, keptCallId }) => [messageId, duplicateResultStub(keptCallId)])),
    summarise: plan.summarise,
    ...(plan.summarise.length === 0 ? {} : { summary: summaryMessage(`summary ${summarySeq}`, summarySeq) }),
  };
}

describe('applyCompaction', () => {
  it('stubs results in place, keeping the tool message and its pairing', () => {
    const state = historyBuilder().head().round({ callId: 'c0' }).build();
    const after = applyCompaction({ state, changes: { ...NO_CHANGES, stubs: new Map([['r:m3', { text: 'stub', handle: 'H1' }]]) } });
    expect(after[3]).toMatchObject({ id: 'r:m3', kind: 'stub', originalHandle: 'H1', pairId: 'c0', message: { role: 'tool', toolCallId: 'c0', text: 'stub' } });
    expect(after[3]!.tokens).toBeLessThan(state[3]!.tokens);
  });

  it('hoists non-compactable messages ahead of the single summary and keeps compactable order', () => {
    const state = historyBuilder().head().round({ callId: 'c0' }).answer('a1').round({ callId: 'c1' }).round({ callId: 'c2' }).answer('a2').build();
    const after = applyCompaction({ state, changes: { ...NO_CHANGES, summarise: ['r:m2', 'r:m3'], summary: summaryMessage('S') } });
    expect(after.map(({ kind, message: { text } }) => (kind === 'answer' || kind === 'summary' ? text : kind))).toEqual(['system', 'brief', 'a1', 'a2', 'S', 'assistant', 'tool', 'assistant', 'tool']);
    expect(after.map(({ seq }) => seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(cacheBreakpoints({ state: after, hasVolatile: true })).toEqual([0, 3, 4, 8]);
  });

  it('never rewrites a non-compactable message, even if asked to', () => {
    const state = historyBuilder().head().round({ callId: 'c0', isCompactable: false }).build();
    expect(applyCompaction({ state, changes: { ...NO_CHANGES, stubs: new Map([['r:m3', { text: 'stub', handle: 'H1' }]]), dedupes: new Map([['r:m1', 'x']]) } })).toEqual(state);
  });

  it('replaces the previous summary with the new one', () => {
    const state = [...historyBuilder().head().build(), summaryMessage('old', 50)];
    const after = applyCompaction({ state, changes: { ...NO_CHANGES, summary: summaryMessage('new', 51) } });
    expect(after.filter(({ kind }) => kind === 'summary').map(({ message: { text } }) => text)).toEqual(['new']);
  });

  it('changes the prefix only at the compaction and is append-only around it', () => {
    const builder = historyBuilder().head();
    for (let round = 0; round < 8; round += 1) builder.round({ callId: `c${round}`, resultChars: 2_000 });
    const before = builder.build();
    const tokens = stateTokens(before);
    const plan = planCompaction({ state: before, policy: DEFAULT_COMPACTION_POLICY, usableBudget: Math.ceil(tokens / 0.8), estimate: { tokens, ratio: 1 } })!;
    const after = applyCompaction({ state: before, changes: changesFor(plan, 100) });
    const hash = (state: readonly ContextMessage[]): string => computePrefixHash(state.map(({ message }) => message), []);
    expect(hash(after)).not.toBe(hash(before));
    const next = [...after, ...historyBuilder().head().round({ callId: 'c9' }).build().slice(2)];
    expect(hash(next.slice(0, after.length))).toBe(hash(after));
  });
});

// ─── Property ───

type Entry = { type: 'round'; isCompactable: boolean; resultChars: number; duplicate: boolean } | { type: 'answer' } | { type: 'pinned' };

const entryArbitrary: fc.Arbitrary<Entry> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ type: fc.constant('round' as const), isCompactable: fc.integer({ min: 0, max: 4 }).map(roll => roll > 0), resultChars: fc.integer({ min: 10, max: 3_000 }), duplicate: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ type: 'answer' as const }) },
  { weight: 1, arbitrary: fc.constant({ type: 'pinned' as const }) },
);

/** Appends generated entries as new messages after the existing ones, with fresh ids. */
function appendEntries(params: { state: ContextMessage[]; entries: Entry[]; counter: { next: number } }): void {
  const { state, entries, counter } = params;
  const add = (entry: Omit<Parameters<typeof createContextMessage>[0], 'runId' | 'seq' | 'createdAt'>): void => {
    state.push({ ...createContextMessage({ runId: 'p', seq: counter.next, createdAt: counter.next, ...entry }), seq: state.length });
    counter.next += 1;
  };
  for (const entry of entries) {
    if (entry.type === 'answer') { add({ kind: 'answer', message: { role: 'user', text: `answer ${counter.next}` } }); continue; }
    if (entry.type === 'pinned') { add({ kind: 'user', flags: { pinned: true }, message: { role: 'user', text: `pin ${counter.next}` } }); continue; }
    const callId = `c${counter.next}`;
    const flags = entry.isCompactable ? {} : { flags: { compactable: false } };
    add({ kind: 'assistant', pairId: callId, ...flags, message: { role: 'assistant', text: '', toolCalls: [{ id: callId, name: 'read', args: { n: counter.next } }] } });
    add({ kind: 'tool', pairId: callId, ...flags, message: { role: 'tool', toolCallId: callId, text: entry.duplicate ? 'D'.repeat(200) : `${callId}`.padEnd(entry.resultChars, 'x') } });
  }
}

/** Every tool message directly follows its assistant call or another result of the same round. */
function arePairsIntact(state: readonly ContextMessage[]): boolean {
  return state.every((message, index) => {
    const { toolCallId } = message.message;
    if (toolCallId == null) return true;
    for (let back = index - 1; back >= 0; back -= 1) {
      const previous = state[back]!.message;
      if (previous.role === 'tool') continue;
      return previous.role === 'assistant' && (previous.toolCalls ?? []).some(({ id }) => id === toolCallId);
    }
    return false;
  });
}

describe('compaction property', () => {
  it('keeps non-compactable messages byte-identical and ordered, one summary at most, pairs intact and recent turns verbatim', () => {
    fc.assert(fc.property(
      fc.array(fc.array(entryArbitrary, { minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 6 }),
      fc.integer({ min: 1, max: 4 }),
      fc.double({ min: 0.76, max: 1.5, noNaN: true }),
      (batches, keepRecent, pressure) => {
        const state = historyBuilder().head().build();
        const counter = { next: 100 };
        const policy = { ...DEFAULT_COMPACTION_POLICY, keepRecent, minSavingTokens: 0 };
        const protectedSoFar: ContextMessage[] = state.filter(({ compactable }) => !compactable);
        let current = state;
        for (const entries of batches) {
          const appended = [...current];
          appendEntries({ state: appended, entries, counter });
          protectedSoFar.push(...appended.slice(current.length).filter(({ compactable }) => !compactable));
          const tokens = stateTokens(appended);
          const plan = planCompaction({ state: appended, policy, usableBudget: Math.ceil(tokens / pressure), estimate: { tokens, ratio: 1 } });
          const recentBefore = compactionGroups(appended).filter(({ messages }) => messages[0]?.message.role === 'assistant').slice(-keepRecent).flatMap(({ messages }) => messages);
          current = plan == null ? appended : applyCompaction({ state: appended, changes: changesFor(plan, counter.next++) });
          const survivors = current.filter(({ id }) => protectedSoFar.some(kept => kept.id === id));
          expect(survivors).toEqual(protectedSoFar.map(kept => ({ ...kept, seq: survivors.find(({ id }) => id === kept.id)?.seq })));
          expect(current.filter(({ kind }) => kind === 'summary').length).toBeLessThanOrEqual(1);
          expect(arePairsIntact(current)).toBe(true);
          for (const recent of recentBefore) expect(current.find(({ id }) => id === recent.id)?.message).toEqual(recent.message);
        }
      },
    ), { numRuns: 150 });
  });
});
