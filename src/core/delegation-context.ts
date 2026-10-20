import type { DelegatedUsage, DelegationContext, DelegationSlot } from './delegation-types.js';
import type { RunTotals, RunTurnParams } from './run-turn.js';

function addUsage(params: { total: DelegatedUsage | undefined; usage: Omit<DelegatedUsage, 'runs'> }): DelegatedUsage {
  const { total = { runs: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, turns: 0, toolCalls: 0 }, usage } = params;
  const cost = total.costUsd == null && usage.costUsd == null ? undefined : (total.costUsd ?? 0) + (usage.costUsd ?? 0);
  return {
    runs: total.runs + 1, inputTokens: total.inputTokens + usage.inputTokens, outputTokens: total.outputTokens + usage.outputTokens,
    cachedTokens: total.cachedTokens + usage.cachedTokens, turns: total.turns + usage.turns, toolCalls: total.toolCalls + usage.toolCalls,
    ...(cost == null ? {} : { costUsd: cost }),
  };
}

/** Tool calls the run has used or promised: its own, its finished sub-runs' and those reserved for sub-runs in flight. */
export function toolCallsCommitted(totals: RunTotals): number {
  return totals.toolCalls + (totals.delegated?.toolCalls ?? 0) + (totals.delegationReserved ?? 0);
}

/**
 * The delegation side of one call's context: sub-runs it starts are linked to this run and call (`parent`), their
 * events come back as `delegated` events of this run, and their usage is added to its `usage.delegated`.
 */
export function delegationFor(params: { turn: RunTurnParams; callId: string }): DelegationContext | undefined {
  const { turn, callId } = params;
  const { delegation, runId, agentName, instanceId, signal, stopSignal, totals, emit, maxToolCalls } = turn;
  if (delegation == null) return undefined;
  const { depth, ancestors, startSubRun, isUnattended, priority } = delegation;
  const admit = ({ maxConcurrent, wantedToolCalls }: { maxConcurrent: number; wantedToolCalls: number }): DelegationSlot | { refused: 'concurrency' | 'budget' } => {
    if (delegation.inFlight >= maxConcurrent) return { refused: 'concurrency' };
    const granted = Math.min(wantedToolCalls, maxToolCalls - toolCallsCommitted(totals));
    if (granted < 1) return { refused: 'budget' };
    delegation.inFlight += 1;
    totals.delegationReserved = (totals.delegationReserved ?? 0) + granted;
    let isReleased = false;
    return {
      toolCalls: granted,
      release: () => {
        if (isReleased) return;
        isReleased = true;
        delegation.inFlight -= 1;
        totals.delegationReserved = (totals.delegationReserved ?? granted) - granted;
      },
    };
  };
  return {
    depth, ancestors, isUnattended, priority, runSignal: signal, stopSignal: stopSignal ?? signal, admit,
    start: ({ agentName: child, input }) => startSubRun?.({ agentName: child, input: { ...input, parent: { agentName, instanceId, runId, callId, depth: depth + 1, ancestors } } }),
    forward: ({ agentName: child, runId: childRunId, event }) => emit({ type: 'delegated', callId, agentName: child, runId: childRunId, event }),
    addUsage: usage => { totals.delegated = addUsage({ total: totals.delegated, usage }); },
  };
}
