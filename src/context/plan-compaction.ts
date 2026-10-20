import { compactionGroups } from './compaction-groups.js';
import type { CompactionGroup } from './compaction-groups.js';
import type { CompactionPolicy } from './compaction-policy.js';
import type { ContextMessage } from './context-message.js';
import { duplicateStubTokens, stubTokens } from './tool-result-stub.js';

/** Tokens planned for the summary the summariser writes (its prompt asks for well under this). */
export const SUMMARY_ALLOWANCE_TOKENS = 400;
/** The latest round always stays verbatim: providers want the last assistant turn (and its thinking) as sent. */
const MIN_KEEP_RECENT = 1;

/** The current prompt size: calibrated tokens, and the calibration ratio that turns raw estimates into them. */
export interface PromptEstimate {
  tokens: number;
  ratio: number;
}

/** Replace a stale tool result with a stub naming its `result_original` handle. */
export interface StubAction {
  messageId: string;
  tool: string;
  callId: string;
  /** Raw estimated tokens of the result. */
  tokens: number;
  /** Raw tokens the stub saves. */
  saving: number;
}

/** Replace an older copy of an identical tool result with a reference to the kept one. */
export interface DedupeAction {
  messageId: string;
  keptCallId: string;
}

/** What a compaction will do, stage by stage; `applyCompaction` carries it out. */
export interface CompactionPlan {
  tokensBefore: number;
  /** `compactTo` of the usable budget. */
  targetTokens: number;
  /** Stage 1: biggest stale results first, until the estimate reaches the target. */
  stubs: StubAction[];
  /** The other stub candidates, used only if the summary stage fails. */
  spareStubs: StubAction[];
  /** Stage 2. */
  dedupes: DedupeAction[];
  /** Stage 3: messages folded (with any previous summary) into the one new summary, in stored order; empty when not needed. */
  summarise: string[];
  /** Recent rounds kept verbatim: `keepRecent`, or fewer (at least 1) when only that reaches `compactTo`. */
  recentKept: number;
  /** First message of the recent window; non-compactable messages from it on keep their place (see `applyCompaction`). */
  recentFrom?: string;
  /** Calibrated estimates after each stage. */
  estimates: { afterStubs: number; afterDedupe: number; afterSummary: number };
}

export interface PlanCompactionParams {
  state: readonly ContextMessage[];
  policy: CompactionPolicy;
  usableBudget: number;
  estimate: PromptEstimate;
}

interface OlderGroups {
  /** Compactable, answered groups older than the recent window: stubbed, deduplicated or summarised. */
  eligible: CompactionGroup[];
  /** Answered older groups holding a non-compactable message: hoisted whole, so their compactable results are stubbed. */
  kept: CompactionGroup[];
  /** First message of the recent window, when there is one. */
  recentFrom?: string;
}

/** The groups older than the last `keepRecent` turns, split by what compaction may do with them. */
function olderGroups(params: { state: readonly ContextMessage[]; keepRecent: number }): OlderGroups {
  const { state, keepRecent } = params;
  const groups = compactionGroups(state);
  const turnStarts = groups.flatMap((group, index) => (group.messages[0]?.message.role === 'assistant' ? [index] : []));
  const firstRecent = turnStarts.length < keepRecent ? 0 : turnStarts[turnStarts.length - keepRecent] ?? 0;
  const older = groups.slice(0, firstRecent).filter(({ isPending }) => !isPending);
  const recentFrom = groups[firstRecent]?.messages[0]?.id;
  return { eligible: older.filter(({ isCompactable }) => isCompactable), kept: older.filter(({ isCompactable }) => !isCompactable), ...(recentFrom == null ? {} : { recentFrom }) };
}

function toolNameOf(params: { group: CompactionGroup; callId: string }): string {
  const { group, callId } = params;
  const call = group.messages.flatMap(({ message: { toolCalls = [] } }) => toolCalls).find(({ id }) => id === callId);
  return call?.name ?? 'unknown';
}

/** Tool results whose stub is smaller than they are, biggest saving first (ties in stored order). */
function stubCandidates(groups: readonly CompactionGroup[]): StubAction[] {
  return groups.flatMap(group => group.messages.flatMap(({ id, kind, tokens, compactable, message: { toolCallId } }): StubAction[] => {
    if (kind !== 'tool' || toolCallId == null || !compactable) return [];
    const tool = toolNameOf({ group, callId: toolCallId });
    const saving = tokens - stubTokens({ tool, callId: toolCallId, tokens });
    return saving > 0 ? [{ messageId: id, tool, callId: toolCallId, tokens, saving }] : [];
  })).sort((left, right) => right.saving - left.saving);
}

/** Older eligible copies of a tool result that appears again later (anywhere), with what each saves. */
function dedupeCandidates(params: { state: readonly ContextMessage[]; groups: readonly CompactionGroup[]; stubbed: ReadonlySet<string> }): (DedupeAction & { saving: number })[] {
  const { state, groups, stubbed } = params;
  const latestByText = new Map<string, string>();
  for (const { kind, message: { text, toolCallId } } of state) if (kind === 'tool' && text != null && toolCallId != null) latestByText.set(text, toolCallId);
  return groups.flatMap(({ messages }) => messages.flatMap(({ id, kind, tokens, message: { text, toolCallId } }) => {
    const keptCallId = text == null ? undefined : latestByText.get(text);
    if (kind !== 'tool' || stubbed.has(id) || keptCallId == null || keptCallId === toolCallId) return [];
    const saving = tokens - duplicateStubTokens(keptCallId);
    return saving > 0 ? [{ messageId: id, keptCallId, saving }] : [];
  }));
}

/** Raw tokens of a message once the stub and dedupe stages have run. */
function tokensAfterStages(params: { message: ContextMessage; stubs: ReadonlyMap<string, StubAction>; dedupes: ReadonlyMap<string, number> }): number {
  const { message: { id, tokens }, stubs, dedupes } = params;
  return tokens - (stubs.get(id)?.saving ?? 0) - (dedupes.get(id) ?? 0);
}

/** One plan with a fixed number of verbatim recent rounds. */
function planWithRecent(params: PlanCompactionParams & { keepRecent: number }): CompactionPlan | undefined {
  const { state, policy: { compactAt, compactTo, minSavingTokens }, keepRecent, usableBudget, estimate: { tokens: tokensBefore, ratio } } = params;
  if (tokensBefore < compactAt * usableBudget) return undefined;
  const targetTokens = Math.floor(compactTo * usableBudget);
  const { eligible: groups, kept, recentFrom } = olderGroups({ state, keepRecent });
  // Results riding in a kept round are hoisted with it and frozen there, so they are stubbed whatever the target.
  const stubs: StubAction[] = stubCandidates(kept);
  let running = tokensBefore - stubs.reduce((total, { saving }) => total + saving, 0) * ratio;
  const spareStubs: StubAction[] = [];
  for (const candidate of stubCandidates(groups)) {
    if (running <= targetTokens) { spareStubs.push(candidate); continue; }
    stubs.push(candidate);
    running -= candidate.saving * ratio;
  }
  const afterStubs = running;
  const stubbed = new Map(stubs.map(stub => [stub.messageId, stub]));
  const dedupeActions = running > targetTokens ? dedupeCandidates({ state, groups, stubbed: new Set(stubbed.keys()) }) : [];
  running -= dedupeActions.reduce((total, { saving }) => total + saving, 0) * ratio;
  const afterDedupe = running;
  const dedupeSavings = new Map(dedupeActions.map(({ messageId, saving }) => [messageId, saving]));
  const summarisable = groups.flatMap(({ messages }) => messages);
  // A previous summary is only re-written (and its size only credited) when there is something new to fold into it.
  const previousSummary = summarisable.length === 0 ? 0 : state.find(({ kind }) => kind === 'summary')?.tokens ?? 0;
  const summarySaving = summarisable.reduce((total, message) => total + tokensAfterStages({ message, stubs: stubbed, dedupes: dedupeSavings }), previousSummary) - SUMMARY_ALLOWANCE_TOKENS;
  const isSummarised = running > targetTokens && summarisable.length > 0 && summarySaving > 0;
  if (isSummarised) running -= summarySaving * ratio;
  const hasWork = stubs.length > 0 || dedupeActions.length > 0 || isSummarised;
  if (!hasWork) return undefined;
  if (tokensBefore - running < minSavingTokens && tokensBefore <= usableBudget) return undefined;
  return {
    tokensBefore, targetTokens, stubs, spareStubs, recentKept: keepRecent, ...(recentFrom == null ? {} : { recentFrom }),
    dedupes: dedupeActions.map(({ messageId, keptCallId }) => ({ messageId, keptCallId })),
    summarise: isSummarised ? summarisable.map(({ id }) => id) : [],
    estimates: { afterStubs, afterDedupe, afterSummary: running },
  };
}

/**
 * Decides a compaction, or returns undefined when the estimate is below `compactAt` or the saving would be under
 * `minSavingTokens` while the prompt still fits. Stages run in order (stub, dedupe, summarise) only while the
 * estimate is above `compactTo`. When the last `keepRecent` rounds alone keep the estimate above `compactTo`, fewer
 * recent rounds are kept (never fewer than one), so the compaction lands well below `compactAt` instead of firing
 * again on the next turn. Pure: handles and the summary text are supplied when the plan is applied.
 */
export function planCompaction(params: PlanCompactionParams): CompactionPlan | undefined {
  const { policy: { keepRecent }, usableBudget } = params;
  const planned = planWithRecent({ ...params, keepRecent });
  if (planned == null || planned.estimates.afterSummary <= planned.targetTokens) return planned;
  let mostAggressive: CompactionPlan = planned;
  for (let recent = keepRecent - 1; recent >= MIN_KEEP_RECENT; recent -= 1) {
    const plan = planWithRecent({ ...params, keepRecent: recent });
    if (plan == null) continue;
    if (plan.estimates.afterSummary <= plan.targetTokens) return plan;
    mostAggressive = plan;
  }
  // Short of the target either way: keep the policy's recent rounds unless only fewer make the prompt fit.
  return planned.estimates.afterSummary <= usableBudget ? planned : mostAggressive;
}
