import type { TaskResult } from '../../../core/agent-types.js';

const CHARS_PER_TOKEN = 4;
/** Most sub-run errors passed back in full. */
const MAX_RETURNED_ERRORS = 10;
/** Most target names written into the tool description (a long list would bloat every prompt). */
const MAX_DESCRIBED_TARGETS = 8;

/** The model-facing description, naming at most `MAX_DESCRIBED_TARGETS` targets. */
export function delegateDescription(names: readonly string[]): string {
  const shown = names.slice(0, MAX_DESCRIBED_TARGETS).join(', ');
  const more = names.length > MAX_DESCRIBED_TARGETS ? ` and ${names.length - MAX_DESCRIBED_TARGETS} more` : '';
  return `Hand a self-contained task to another agent (${shown}${more}) and get back its status and answer. It sees only the task text you give it.`;
}

/** What the model gets back: status, the answer within its budget (with where to find the rest), usage and errors. */
export function envelopeOf(params: { agent: string; result: TaskResult; budgetTokens: number }): Record<string, unknown> {
  const { agent, result: { runId, status, answer, usage, errors, failure }, budgetTokens } = params;
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  const isCut = answer.length > budgetChars;
  const shown = isCut ? `${answer.slice(0, budgetChars)}… [answer cut at ${budgetTokens} tokens; the full answer is in run ${runId}]` : answer;
  const { inputTokens, outputTokens, cachedTokens, turns, toolCalls, durationMs } = usage;
  return {
    agent, runId, status, answer: shown, truncated: isCut, ...(isCut ? { fullAnswer: { runId, chars: answer.length } } : {}),
    usage: { inputTokens, outputTokens, cachedTokens, turns, toolCalls, durationMs },
    errors: errors.slice(0, MAX_RETURNED_ERRORS), ...(errors.length > MAX_RETURNED_ERRORS ? { moreErrors: errors.length - MAX_RETURNED_ERRORS } : {}),
    ...(failure == null ? {} : { failure }),
  };
}
