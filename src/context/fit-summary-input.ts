import { compactionGroups } from './compaction-groups.js';
import type { ContextMessage } from './context-message.js';
import { estimatePromptTokens } from './estimate-prompt-tokens.js';
import { SUMMARY_ALLOWANCE_TOKENS } from './plan-compaction.js';
import { summaryRequestMessages } from './summarise.js';

/** A written summary larger than this is treated as a summariser failure: it would replace history with more history. */
export const SUMMARY_MAX_TOKENS = 2 * SUMMARY_ALLOWANCE_TOKENS;

export interface FitSummaryInputParams {
  previousSummary?: string;
  /** The messages planned for the summary, in stored order. */
  messages: readonly ContextMessage[];
  /** Prompt tokens the summariser model can take (its window less its output reserve). */
  budget: number;
}

function requestTokens(params: { previousSummary?: string; messages: readonly ContextMessage[] }): number {
  return estimatePromptTokens({ messages: summaryRequestMessages(params), tools: [] });
}

/**
 * The longest run of whole rounds, oldest first, whose summary request fits the summariser's budget: a small
 * summariser model summarises part of the history instead of failing on all of it. Empty when not even the first
 * round fits.
 */
export function fitSummaryInput(params: FitSummaryInputParams): ContextMessage[] {
  const { previousSummary, messages, budget } = params;
  const base = previousSummary == null ? {} : { previousSummary };
  if (requestTokens({ ...base, messages }) <= budget) return [...messages];
  const fitted: ContextMessage[] = [];
  for (const { messages: round } of compactionGroups(messages)) {
    if (requestTokens({ ...base, messages: [...fitted, ...round] }) > budget) break;
    fitted.push(...round);
  }
  return fitted;
}
