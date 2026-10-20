import { describe, expect, it } from 'vitest';
import { historyBuilder, stateTokens } from './compaction.test-support.js';
import { DEFAULT_COMPACTION_POLICY } from './compaction-policy.js';
import { compactionGroups } from './compaction-groups.js';
import { planCompaction } from './plan-compaction.js';

/** Long enough to be worth replacing by a short reference, too short to be worth a stub. */
const SAME = 'same:'.padEnd(80, 'y');
const POLICY = { ...DEFAULT_COMPACTION_POLICY, keepRecent: 2, minSavingTokens: 0 };

function rounds(count: number, resultChars = 400) {
  const builder = historyBuilder().head();
  for (let round = 0; round < count; round += 1) builder.round({ callId: `c${round}`, resultChars });
  return builder.build();
}

describe('compactionGroups', () => {
  it('groups a tool round atomically and marks unanswered calls as pending', () => {
    const state = rounds(2);
    state.push({ ...state[2]!, id: 'r:m99', pairId: 'c9', message: { role: 'assistant', toolCalls: [{ id: 'c9', name: 'read', args: {} }] } });
    expect(compactionGroups(state).map(({ messages, isPending }) => ({ ids: messages.map(({ id }) => id), isPending }))).toEqual([
      { ids: ['r:m2', 'r:m3'], isPending: false },
      { ids: ['r:m4', 'r:m5'], isPending: false },
      { ids: ['r:m99'], isPending: true },
    ]);
  });
});

describe('planCompaction', () => {
  it('does nothing below compactAt', () => {
    const state = rounds(6);
    const tokens = stateTokens(state);
    expect(planCompaction({ state, policy: POLICY, usableBudget: Math.ceil(tokens / 0.74), estimate: { tokens, ratio: 1 } })).toBeUndefined();
  });

  it('stubs the biggest stale tool results first and stops once at or below compactTo', () => {
    const builder = historyBuilder().head();
    [400, 2_000, 800, 400, 400, 400].forEach((resultChars, round) => builder.round({ callId: `c${round}`, resultChars }));
    const state = builder.build();
    const tokens = stateTokens(state);
    const usableBudget = Math.ceil(tokens / 0.8);
    const plan = planCompaction({ state, policy: POLICY, usableBudget, estimate: { tokens, ratio: 1 } });
    expect(plan?.stubs.map(({ callId }) => callId)).toEqual(['c1', 'c2']);
    expect(plan?.summarise).toEqual([]);
    expect(plan!.estimates.afterSummary).toBeLessThanOrEqual(plan!.targetTokens);
    // The recent rounds (c4, c5) are never touched; the rest stay available for a fallback.
    expect(plan?.spareStubs.map(({ callId }) => callId)).toEqual(['c0', 'c3']);
  });

  it('drops older exact duplicates of a tool result before summarising', () => {
    const builder = historyBuilder().head().round({ callId: 'c0', text: SAME }).round({ callId: 'c1', text: SAME });
    for (let round = 2; round < 6; round += 1) builder.round({ callId: `c${round}`, resultChars: 40 });
    builder.round({ callId: 'c6', text: SAME });
    const state = builder.build();
    const tokens = stateTokens(state);
    const plan = planCompaction({ state, policy: { ...POLICY, compactTo: 0.6, compactAt: 0.7 }, usableBudget: Math.ceil(tokens / 0.72), estimate: { tokens, ratio: 1 } });
    expect(plan?.dedupes).toEqual([{ messageId: 'r:m3', keptCallId: 'c6' }, { messageId: 'r:m5', keptCallId: 'c6' }]);
  });

  it('summarises every eligible round when stubbing is not enough, keeping recent and non-compactable ones', () => {
    const builder = historyBuilder().head();
    const roundCount = 30;
    for (let round = 0; round < roundCount; round += 1) builder.round({ callId: `c${round}`, resultChars: 80, isCompactable: round !== 1 });
    const state = builder.build();
    const tokens = stateTokens(state);
    const plan = planCompaction({ state, policy: { ...POLICY, compactTo: 0.3 }, usableBudget: Math.ceil(tokens / 0.9), estimate: { tokens, ratio: 1 } });
    // Rounds 0 and 2..27: round 1 is non-compactable and the last two are recent. Round n is messages 2n+2 and 2n+3.
    const summarised = [0, ...Array.from({ length: roundCount - 4 }, (_unused, offset) => offset + 2)].flatMap(round => [`r:m${2 * round + 2}`, `r:m${2 * round + 3}`]);
    expect(plan?.summarise).toEqual(summarised);
    expect(plan!.estimates.afterSummary).toBeLessThan(plan!.estimates.afterDedupe);
  });

  it('returns undefined when the saving is below minSavingTokens and the prompt still fits', () => {
    const state = rounds(6, 40);
    const tokens = stateTokens(state);
    expect(planCompaction({ state, policy: { ...POLICY, minSavingTokens: 10_000 }, usableBudget: Math.ceil(tokens / 0.8), estimate: { tokens, ratio: 1 } })).toBeUndefined();
  });

  it('scales savings by the calibration ratio', () => {
    const state = rounds(6, 2_000);
    const raw = stateTokens(state);
    const plan = planCompaction({ state, policy: POLICY, usableBudget: Math.ceil((raw * 2) / 0.8), estimate: { tokens: raw * 2, ratio: 2 } });
    expect(plan!.tokensBefore - plan!.estimates.afterStubs).toBe(2 * plan!.stubs.reduce((total, { saving }) => total + saving, 0));
  });
});
