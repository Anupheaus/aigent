import type { DelegatedUsage, DelegationContext } from './delegation-types.js';
import type { RunTurnParams } from './run-turn.js';

function addUsage(params: { total: DelegatedUsage | undefined; usage: Omit<DelegatedUsage, 'runs'> }): DelegatedUsage {
  const { total = { runs: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, turns: 0, toolCalls: 0 }, usage } = params;
  const cost = total.costUsd == null && usage.costUsd == null ? undefined : (total.costUsd ?? 0) + (usage.costUsd ?? 0);
  return {
    runs: total.runs + 1, inputTokens: total.inputTokens + usage.inputTokens, outputTokens: total.outputTokens + usage.outputTokens,
    cachedTokens: total.cachedTokens + usage.cachedTokens, turns: total.turns + usage.turns, toolCalls: total.toolCalls + usage.toolCalls,
    ...(cost == null ? {} : { costUsd: cost }),
  };
}

/**
 * The delegation side of one call's context: sub-runs it starts are linked to this run and call (`parent`), their
 * events come back as `delegated` events of this run, and their usage is added to its `usage.delegated`.
 */
export function delegationFor(params: { turn: RunTurnParams; callId: string }): DelegationContext | undefined {
  const { turn, callId } = params;
  const { delegation, runId, agentName, instanceId, signal, stopSignal, totals, emit } = turn;
  if (delegation == null) return undefined;
  const { depth, startSubRun, isUnattended, priority } = delegation;
  return {
    depth, isUnattended, priority, runSignal: signal, stopSignal: stopSignal ?? signal,
    start: ({ agentName: child, input }) => startSubRun?.({ agentName: child, input: { ...input, parent: { agentName, instanceId, runId, callId, depth: depth + 1 } } }),
    forward: ({ agentName: child, runId: childRunId, event }) => emit({ type: 'delegated', callId, agentName: child, runId: childRunId, event }),
    addUsage: usage => { totals.delegated = addUsage({ total: totals.delegated, usage }); },
  };
}
