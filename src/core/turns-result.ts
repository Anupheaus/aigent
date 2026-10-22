import type { Compactor } from '../context/compactor.js';
import type { RunPlanning } from '../planning/run-planning.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import type { TaskResultData, TaskUsage } from './agent-types.js';
import type { Citation } from './citations.js';
import type { TaskStatus } from './aigent-events.js';
import type { AbortReason } from './run-control.js';
import { finalStatus, planningResult } from './run-planning-setup.js';
import type { RunContext } from './run-context.js';
import type { RunTotals } from './run-turn.js';

/** A run aborted by its timeout reached a limit; any other abort is a cancellation. */
export function abortedStatus(reason: AbortReason | undefined): TaskStatus {
  return reason === 'timeout' ? 'limit_reached' : 'cancelled';
}

/** Tool calls per model request; 0 before any request, so a run that never reached the model does not divide by zero. */
function toolCallsPerTurn(totals: RunTotals): number {
  const { turns, toolCalls } = totals;
  return turns === 0 ? 0 : toolCalls / turns;
}

/** The compaction figures for `TaskUsage`, only when the run compacted (or paid for a summary). */
function compactionUsage(params: { compactor: Compactor; totals: RunTotals }): Pick<TaskUsage, 'compactions' | 'compactionTokens' | 'compactionTokensSaved'> {
  const { compactor, totals: { compactionTokens } } = params;
  const { compactions, tokensSaved } = compactor.stats();
  if (compactions === 0 && compactionTokens === 0) return {};
  return { compactions, compactionTokens, compactionTokensSaved: tokensSaved };
}

export interface BuildTurnsResultParams {
  ids: Pick<TaskResultData, 'runId' | 'responseId' | 'agentName' | 'instanceId'>;
  outcome: { status: TaskStatus; answer: string; failure?: string; errors: ToolErrorDetail[]; output?: unknown; citations?: Citation[] };
  totals: RunTotals;
  context: RunContext;
  compactor: Compactor;
  planning: RunPlanning;
  durationMs: number;
}

/** The loop's result: status after plan and todo, usage with the context figures, and the stop mode. */
export function buildTurnsResult(params: BuildTurnsResultParams): TaskResultData {
  const { ids, outcome: { status, answer, failure, errors, output, citations }, totals, context, compactor, planning, durationMs } = params;
  const { usage, turns, toolCalls, retries, fallbacks } = totals;
  const result: TaskResultData = {
    ...planningResult(planning),
    ...ids, status: finalStatus({ status, planning }), answer, errors,
    usage: {
      ...usage, turns, toolCalls, toolCallsPerTurn: toolCallsPerTurn(totals), retries, fallbacks, durationMs,
      ...(context.peakTokens > 0 ? { contextTokensPeak: context.peakTokens } : {}),
      ...compactionUsage({ compactor, totals }),
      ...(totals.delegated == null ? {} : { delegated: { ...totals.delegated } }),
    },
  };
  if (failure != null) result.failure = failure;
  if (output !== undefined) result.output = output;
  if (citations != null && citations.length > 0) result.citations = citations;
  if (status === 'stopped') result.stopMode = 'graceful';
  if (status === 'cancelled') result.stopMode = 'immediate';
  return result;
}
