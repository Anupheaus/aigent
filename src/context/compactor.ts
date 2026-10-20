import { createAigentError, isAigentError } from '../core/aigent-error.js';
import type { AigentError } from '../core/aigent-error.js';
import type { AigentEvent, CompactionStage } from '../core/aigent-events.js';
import { describeError } from '../core/describe-value.js';
import { applyCompaction } from './apply-compaction.js';
import type { CompactionChanges } from './apply-compaction.js';
import type { CompactionPolicy } from './compaction-policy.js';
import type { ContextMessage } from './context-message.js';
import { fitSummaryInput, SUMMARY_MAX_TOKENS } from './fit-summary-input.js';
import { planCompaction } from './plan-compaction.js';
import type { StubAction } from './plan-compaction.js';
import { duplicateResultStub, toolResultStub } from './tool-result-stub.js';

/** Above this share of the usable budget, the never-compacted messages alone earn a warning... */
export const NON_COMPACTABLE_WARN_SHARE = 0.6;
/** ...and above this one the run fails: compaction could never make enough room. */
export const NON_COMPACTABLE_MAX_SHARE = 0.9;

/** The run state a compactor works on; `state` is replaced in place. */
export interface CompactableContext {
  state: ContextMessage[];
  /** Calibration ratio of raw estimates to provider counts. */
  ratio: number;
}

/** What the summariser wrote, and its own token usage (input plus output). */
export interface WrittenSummary {
  text: string;
  usageTokens: number;
}

export interface CreateCompactorParams {
  context: CompactableContext;
  policy: CompactionPolicy;
  usableBudget: number;
  /** Prompt tokens the summariser model can take; a summary request is cut to the oldest rounds that fit. */
  summariserBudget: number;
  /** Raw (uncalibrated) estimate of the next request: the stored messages, tools and volatile block. */
  estimateRaw(): number;
  /** Keeps a verbatim original and returns its `result_original` handle. */
  keepOriginal(text: string): string;
  /** Writes the summary of `messages`, merging `previousSummary`; rejects when the call fails. */
  summarise(request: { previousSummary?: string; messages: ContextMessage[] }): Promise<WrittenSummary>;
  /** The stored summary message for the summariser's text. */
  createSummary(text: string): ContextMessage;
  emit(event: AigentEvent): void;
  /** Called after a compaction changed the state, before the next request is built. */
  onCompacted(stats: { tokensBefore: number; tokensAfter: number }): void;
}

export interface CompactorStats {
  compactions: number;
  /** Calibrated prompt tokens removed by all compactions. */
  tokensSaved: number;
}

export interface Compactor {
  /** Compacts if the next request needs it. Call only at a turn boundary (every tool result stored). Throws `context_overflow`. */
  beforeTurn(params: { remainingTurns: number }): Promise<void>;
  stats(): CompactorStats;
}

function overflow(params: { message: string; details: Record<string, unknown> }): AigentError {
  return createAigentError({ code: 'context_overflow', ...params });
}

function isAbort(error: unknown): boolean {
  return isAigentError(error) && error.code === 'aborted';
}

/** Compaction for one run, serialised: a call while another is running returns without doing anything. */
export function createCompactor(params: CreateCompactorParams): Compactor {
  const { context, policy, usableBudget, summariserBudget, estimateRaw, keepOriginal, summarise, createSummary, emit, onCompacted } = params;
  const stats: CompactorStats = { compactions: 0, tokensSaved: 0 };
  let isCompacting = false;
  let hasWarnedNonCompactable = false;
  // Counts calls to `beforeTurn`; starts high so the first compaction is never held back.
  let turnsSinceCompaction = Number.POSITIVE_INFINITY;
  // The recent window of the plan being applied: its non-compactable messages keep their place.
  let recentFrom: string | undefined;
  const current = (): number => Math.ceil(estimateRaw() * context.ratio);

  function checkNonCompactable(): void {
    const tokens = Math.ceil(context.state.filter(({ compactable }) => !compactable).reduce((total, message) => total + message.tokens, 0) * context.ratio);
    const share = usableBudget === 0 ? Infinity : tokens / usableBudget;
    if (share > NON_COMPACTABLE_MAX_SHARE) {
      throw overflow({ message: `Non-compactable context too large: ${tokens} tokens of a ${usableBudget}-token budget (over ${NON_COMPACTABLE_MAX_SHARE * 100}%); shorten the instructions, plan or pinned messages, or raise contextSize`, details: { nonCompactableTokens: tokens, usableBudget } });
    }
    if (share > NON_COMPACTABLE_WARN_SHARE && !hasWarnedNonCompactable) {
      hasWarnedNonCompactable = true;
      emit({ type: 'warning', message: `Non-compactable context uses ${tokens} tokens of a ${usableBudget}-token budget (over ${NON_COMPACTABLE_WARN_SHARE * 100}%); compaction has little room left` });
    }
  }

  /** Applies one stage to the stored state and reports it. */
  function applyStage(params: { stage: CompactionStage; changes: CompactionChanges; affected: number; summaryTokens?: number }): void {
    const { stage, changes, affected, summaryTokens } = params;
    const tokensBefore = current();
    const placed = recentFrom == null ? changes : { ...changes, recentFrom };
    context.state.splice(0, context.state.length, ...applyCompaction({ state: context.state, changes: placed }));
    emit({ type: 'compaction', stage, tokensBefore, tokensAfter: current(), messagesAffected: affected, ...(summaryTokens == null ? {} : { summaryTokens }) });
  }

  function stubChanges(stubs: readonly StubAction[]): CompactionChanges {
    const replacements = stubs.map(({ messageId, tool, callId, tokens }) => {
      const original = context.state.find(({ id }) => id === messageId)?.message.text ?? '';
      const handle = keepOriginal(original);
      return [messageId, { text: toolResultStub({ tool, callId, tokens, handle }), handle }] as const;
    });
    return { stubs: new Map(replacements), dedupes: new Map(), summarise: [] };
  }

  /** The stubbing fallback when no summary is written; returns whether it changed the state. */
  function stubInstead(spareStubs: readonly StubAction[]): boolean {
    if (spareStubs.length === 0) return false;
    applyStage({ stage: 'stubbed', changes: stubChanges(spareStubs), affected: spareStubs.length });
    return true;
  }

  /** Runs the summary stage; returns whether it changed the state. */
  async function summariseStage(params: { summarise: readonly string[]; spareStubs: readonly StubAction[] }): Promise<boolean> {
    const { summarise: ids, spareStubs } = params;
    const previousSummary = context.state.find(({ kind }) => kind === 'summary')?.message.text;
    const planned = context.state.filter(({ id }) => ids.includes(id));
    const messages = fitSummaryInput({ ...(previousSummary == null ? {} : { previousSummary }), messages: planned, budget: summariserBudget });
    if (messages.length === 0) {
      emit({ type: 'warning', message: `Compaction summary skipped: even the oldest round exceeds the summariser's ${summariserBudget}-token budget; stubbed stale tool results instead` });
      return stubInstead(spareStubs);
    }
    try {
      const { text } = await summarise({ ...(previousSummary == null ? {} : { previousSummary }), messages });
      const summary = createSummary(text);
      if (summary.tokens > SUMMARY_MAX_TOKENS) throw createAigentError({ code: 'provider_failed', message: `the summary is ~${summary.tokens} tokens, over the ${SUMMARY_MAX_TOKENS}-token cap` });
      applyStage({ stage: 'summarised', changes: { stubs: new Map(), dedupes: new Map(), summarise: messages.map(({ id }) => id), summary }, affected: messages.length, summaryTokens: summary.tokens });
      return true;
    } catch (error) {
      if (isAbort(error)) throw error;
      emit({ type: 'warning', message: `Compaction summary failed (${describeError(error)}); stubbed stale tool results instead` });
      return stubInstead(spareStubs);
    }
  }

  /** Applies a plan's stages; returns whether any of them changed the state. */
  async function applyPlan(plan: NonNullable<ReturnType<typeof planCompaction>>): Promise<boolean> {
    const { stubs, dedupes, summarise: ids, spareStubs } = plan;
    recentFrom = plan.recentFrom;
    if (stubs.length > 0) applyStage({ stage: 'stubbed', changes: stubChanges(stubs), affected: stubs.length });
    if (dedupes.length > 0) applyStage({ stage: 'deduped', changes: { stubs: new Map(), dedupes: new Map(dedupes.map(({ messageId, keptCallId }) => [messageId, duplicateResultStub(keptCallId)])), summarise: [] }, affected: dedupes.length });
    const isSummarised = ids.length > 0 && await summariseStage({ summarise: ids, spareStubs });
    return stubs.length > 0 || dedupes.length > 0 || isSummarised;
  }

  async function compact(remainingTurns: number): Promise<void> {
    checkNonCompactable();
    turnsSinceCompaction += 1;
    const tokensBefore = current();
    // A run on its last turn that still fits gains nothing from paying for a compaction.
    if (remainingTurns <= 1 && tokensBefore < usableBudget) return;
    // Hysteresis in turns: a prompt that still fits waits, so the cached prefix is not rewritten turn after turn.
    if (turnsSinceCompaction <= policy.minTurnsBetween && tokensBefore <= usableBudget) return;
    const plan = planCompaction({ state: context.state, policy, usableBudget, estimate: { tokens: tokensBefore, ratio: context.ratio } });
    // A plan whose stages all came to nothing (e.g. a failed summary with no spare stubs) is not a compaction.
    if (plan != null && await applyPlan(plan)) {
      const tokensAfter = current();
      stats.compactions += 1;
      stats.tokensSaved += Math.max(0, tokensBefore - tokensAfter);
      turnsSinceCompaction = 0;
      onCompacted({ tokensBefore, tokensAfter });
    }
    const tokensAfter = current();
    if (tokensAfter > usableBudget) {
      throw overflow({ message: `Context overflow: the prompt needs ~${tokensAfter} tokens but only ${usableBudget} are usable, and compaction cannot free more; raise contextSize or reduce tool result sizes`, details: { tokens: tokensAfter, usableBudget, tokensBefore } });
    }
  }

  return {
    beforeTurn: async ({ remainingTurns }) => {
      if (isCompacting) return;
      isCompacting = true;
      try {
        await compact(remainingTurns);
      } finally {
        isCompacting = false;
      }
    },
    stats: () => ({ ...stats }),
  };
}
