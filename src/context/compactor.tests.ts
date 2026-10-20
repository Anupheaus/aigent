import { describe, expect, it } from 'vitest';
import { createAigentError } from '../core/aigent-error.js';
import type { AigentEvent } from '../core/aigent-events.js';
import { historyBuilder, stateTokens } from './compaction.test-support.js';
import { DEFAULT_COMPACTION_POLICY } from './compaction-policy.js';
import { createCompactor } from './compactor.js';
import type { CompactableContext, CreateCompactorParams, WrittenSummary } from './compactor.js';
import { createContextMessage } from './context-message.js';
import type { ContextMessage } from './context-message.js';

interface Harness {
  context: CompactableContext;
  events: AigentEvent[];
  originals: string[];
  summariseCalls: { previousSummary?: string; messages: ContextMessage[] }[];
  compacted: number[];
  compactor: ReturnType<typeof createCompactor>;
}

function harness(params: { state: ContextMessage[]; usableBudget: number; summarise?: CreateCompactorParams['summarise']; policy?: Partial<typeof DEFAULT_COMPACTION_POLICY> }): Harness {
  const { state, usableBudget, policy } = params;
  const context: CompactableContext = { state, ratio: 1 };
  const events: AigentEvent[] = [];
  const originals: string[] = [];
  const summariseCalls: Harness['summariseCalls'] = [];
  const compacted: number[] = [];
  let summaries = 0;
  const summarise = params.summarise ?? (async (request): Promise<WrittenSummary> => {
    summariseCalls.push(request);
    return { text: 'Goal: test', usageTokens: 50 };
  });
  const compactor = createCompactor({
    context, usableBudget, policy: { ...DEFAULT_COMPACTION_POLICY, minSavingTokens: 0, keepRecent: 2, ...policy },
    estimateRaw: () => stateTokens(context.state),
    keepOriginal: text => { originals.push(text); return `H${originals.length}`; },
    summarise,
    createSummary: text => createContextMessage({ runId: 'r', seq: 1_000 + (summaries += 1), kind: 'summary', createdAt: 0, message: { role: 'user', text } }),
    emit: event => events.push(event),
    onCompacted: ({ tokensAfter }) => compacted.push(tokensAfter),
  });
  return { context, events, originals, summariseCalls, compacted, compactor };
}

function rounds(count: number, resultChars: number): ContextMessage[] {
  const builder = historyBuilder().head();
  for (let round = 0; round < count; round += 1) builder.round({ callId: `c${round}`, resultChars });
  return builder.build();
}

describe('createCompactor', () => {
  it('stubs stale results under handles, emits one event per stage and tells the run', async () => {
    const state = rounds(6, 2_000);
    const tokens = stateTokens(state);
    const run = harness({ state, usableBudget: Math.ceil(tokens / 0.8) });
    await run.compactor.beforeTurn({ remainingTurns: 10 });
    const [event] = run.events;
    expect(event).toMatchObject({ type: 'compaction', stage: 'stubbed', tokensBefore: tokens });
    expect(run.originals[0]).toBe('c0:'.padEnd(2_000, 'x'));
    expect(run.context.state.find(({ kind }) => kind === 'stub')?.message.text).toMatch(/^\[result of read call c0 omitted to save context \(~504 tokens\); refetch with result_original handle H1\]$/);
    expect(run.compacted).toHaveLength(1);
    expect(run.compactor.stats()).toEqual({ compactions: 1, tokensSaved: tokens - run.compacted[0]! });
  });

  it('summarises with the previous summary and the old messages, leaving one summary', async () => {
    const state = [...rounds(30, 80)];
    state.splice(2, 0, createContextMessage({ runId: 'r', seq: 99, kind: 'summary', createdAt: 0, message: { role: 'user', text: 'OLD SUMMARY' } }));
    const tokens = stateTokens(state);
    const run = harness({ state, usableBudget: Math.ceil(tokens / 0.9), policy: { compactTo: 0.3 } });
    await run.compactor.beforeTurn({ remainingTurns: 10 });
    const [call] = run.summariseCalls;
    expect(call?.previousSummary).toBe('OLD SUMMARY');
    expect(call?.messages.map(({ id }) => id)).toContain('r:m2');
    expect(run.context.state.filter(({ kind }) => kind === 'summary').map(({ message: { text } }) => text)).toEqual(['Goal: test']);
    expect(run.events.at(-1)).toMatchObject({ type: 'compaction', stage: 'summarised', summaryTokens: expect.any(Number) });
  });

  it('falls back to stubbing when the summariser fails, then fails clearly if that is not enough', async () => {
    const state = rounds(30, 80);
    const tokens = stateTokens(state);
    const failing = async (): Promise<WrittenSummary> => { throw createAigentError({ code: 'provider_failed', message: 'down' }); };
    const run = harness({ state, usableBudget: Math.ceil(tokens / 0.9), policy: { compactTo: 0.3 }, summarise: failing });
    await run.compactor.beforeTurn({ remainingTurns: 10 });
    expect(run.events).toContainEqual({ type: 'warning', message: expect.stringContaining('Compaction summary failed (down)') });
    const tight = harness({ state: rounds(30, 80), usableBudget: Math.ceil(tokens / 1.2), summarise: failing });
    await expect(tight.compactor.beforeTurn({ remainingTurns: 10 })).rejects.toMatchObject({ code: 'context_overflow', details: { usableBudget: Math.ceil(tokens / 1.2) } });
  });

  it('rethrows an abort from the summariser instead of falling back', async () => {
    const state = rounds(30, 80);
    const run = harness({ state, usableBudget: Math.ceil(stateTokens(state) / 0.9), policy: { compactTo: 0.3 }, summarise: async () => { throw createAigentError({ code: 'aborted', message: 'stopped' }); } });
    await expect(run.compactor.beforeTurn({ remainingTurns: 10 })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('skips a run that will finish within budget, and fails when nothing can be compacted', async () => {
    const state = rounds(6, 2_000);
    const tokens = stateTokens(state);
    const finishing = harness({ state, usableBudget: Math.ceil(tokens / 0.8) });
    await finishing.compactor.beforeTurn({ remainingTurns: 1 });
    expect(finishing.events).toEqual([]);
    const recentOnly = rounds(2, 2_000);
    const overfull = harness({ state: recentOnly, usableBudget: Math.ceil(stateTokens(recentOnly) / 1.1) });
    await expect(overfull.compactor.beforeTurn({ remainingTurns: 10 })).rejects.toMatchObject({ code: 'context_overflow', message: expect.stringContaining('compaction cannot free more') });
  });

  it('warns once above 60% non-compactable and fails above 90%', async () => {
    const head = historyBuilder().head().build();
    head.push(createContextMessage({ runId: 'r', seq: 2, kind: 'pinned', createdAt: 0, message: { role: 'user', text: 'p'.repeat(400) } }));
    const tokens = stateTokens(head);
    const warned = harness({ state: head, usableBudget: Math.ceil(tokens / 0.7) });
    await warned.compactor.beforeTurn({ remainingTurns: 10 });
    await warned.compactor.beforeTurn({ remainingTurns: 10 });
    expect(warned.events.filter(({ type }) => type === 'warning')).toHaveLength(1);
    const failed = harness({ state: head, usableBudget: Math.ceil(tokens / 0.95) });
    await expect(failed.compactor.beforeTurn({ remainingTurns: 10 })).rejects.toMatchObject({ code: 'context_overflow', message: expect.stringContaining('Non-compactable context too large') });
  });

  it('is serialised per run: a second call while one is running does nothing', async () => {
    const state = rounds(30, 80);
    let release: () => void = () => undefined;
    let calls = 0;
    const slow = (): Promise<WrittenSummary> => { calls += 1; return new Promise(resolve => { release = () => resolve({ text: 'S', usageTokens: 1 }); }); };
    const run = harness({ state, usableBudget: Math.ceil(stateTokens(state) / 0.9), policy: { compactTo: 0.3 }, summarise: slow });
    const first = run.compactor.beforeTurn({ remainingTurns: 10 });
    await run.compactor.beforeTurn({ remainingTurns: 10 });
    release();
    await first;
    expect(calls).toBe(1);
  });

  it('does not thrash: a steady stream of small rounds compacts rarely and never on consecutive turns', async () => {
    const roundCount = 200;
    const state = historyBuilder().head().build();
    const run = harness({ state, usableBudget: 3_000, policy: { keepRecent: 4 } });
    const compactedAt: number[] = [];
    for (let round = 0; round < roundCount; round += 1) {
      run.context.state.push(...historyBuilder().round({ callId: `c${round}`, resultChars: 200 }).build().map((message, offset) => ({ ...message, id: `n${round}:${offset}` })));
      const before = run.compacted.length;
      await run.compactor.beforeTurn({ remainingTurns: 10 });
      if (run.compacted.length > before) compactedAt.push(round);
    }
    // Each round adds ~70 tokens; a compaction frees at least 30% of 3,000, so at most one every ~13 rounds.
    expect(compactedAt.length).toBeGreaterThan(1);
    expect(compactedAt.length).toBeLessThanOrEqual(Math.ceil(roundCount / 10));
    expect(compactedAt.every((round, index) => index === 0 || round - compactedAt[index - 1]! > 1)).toBe(true);
    expect(stateTokens(run.context.state)).toBeLessThanOrEqual(3_000);
  });
});
