import type { RunRecord } from '../telemetry/run-record.js';
import { costOfRun } from './pricing.js';
import type { Pricing, RunMetrics } from './report-types.js';

/** Cached input costs roughly a tenth of fresh input, so it counts a tenth towards token efficiency. */
const CACHED_TOKEN_WEIGHT = 0.1;

/** Input (cached input weighted 0.1) plus output tokens. Cached tokens are part of the reported input. */
export function weightedTokens(run: RunRecord): number {
  const { inputTokens, outputTokens, cachedTokens } = run.usage;
  const cached = Math.min(cachedTokens, inputTokens);
  return inputTokens - cached + cached * CACHED_TOKEN_WEIGHT + outputTokens;
}

/** Work items per tool call (batching); null for a run without tool calls. */
export function itemsPerCall(run: RunRecord): number | null {
  const { calls, items } = run.toolUse;
  return calls === 0 ? null : items / calls;
}

/** Share of tool calls that were not repeats of an earlier call; null for a run without tool calls. */
export function nonRepeatShare(run: RunRecord): number | null {
  const { calls, repeats } = run.toolUse;
  return calls === 0 ? null : (calls - repeats) / calls;
}

export function runMetrics(params: { run: RunRecord; pricing?: Pricing }): RunMetrics {
  const { run, pricing } = params;
  const { usage: { turns, toolCalls, toolCallsPerTurn }, timings: { durationMs } } = run;
  return { durationMs, tokens: weightedTokens(run), turns, toolCalls, toolCallsPerTurn, costUsd: costOfRun({ run, ...(pricing == null ? {} : { pricing }) }) };
}

/** Completed and not rated incorrect: the plain reliability used when comparing versions. */
export function isCompletedAndNotRejected(run: RunRecord): boolean {
  return run.userVerdict !== 'incorrect' && (run.userVerdict === 'correct' || run.status === 'completed');
}
