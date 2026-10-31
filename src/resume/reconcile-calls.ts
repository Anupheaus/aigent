import type { AigentEvent } from '../core/aigent-events.js';
import type { NewContextMessage } from '../core/run-context.js';
import { turnMessages } from '../core/turn-messages.js';
import type { ThinkingBlock, ToolCall } from '../providers/provider-types.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import { MULTI_TOOL_NAME } from '../tools/multi-tool.js';
import type { ToolEnvelope } from '../tools/tool-envelope.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { Tool } from '../tools/tool-types.js';
import type { GateOutcome } from '../approvals/approval-gate.js';
import type { TakenMemory } from '../core/run-memory.js';
import type { CallLedger, LedgerEntry } from './call-ledger.js';
import type { RunState } from './checkpoint-types.js';
import { reconcileCall } from './reconcile-call.js';
import { reconcileMulti } from './reconcile-multi.js';

/** What a resumed run starts from: the latest checkpoint, the ledger and results that replace a call's own. */
export interface RestoredRun {
  state: RunState;
  ledger: LedgerEntry[];
  /** Call id → the envelope to give the model (e.g. the answers to a suspended `ask_user`). */
  overrides?: ReadonlyMap<string, ToolEnvelope>;
  /** The checkpoint is not the stream's latest: later records are missing (see `Checkpoint.stale`). */
  stale?: { missingSeq: number; latestSeq: number };
}

/** The completed round, and the number of turns the run had made once its request had been sent. */
export interface ReconciledRound {
  messages: NewContextMessage[];
  turn: number;
}

/** The approval gate for calls a resumed run (re-)runs; `force` asks even when the tool does not require approval. */
export type ReconcileGate = (params: { call: ToolCall; tool: Tool; force?: { reason: string } }) => Promise<GateOutcome>;

export interface ReconcileParams {
  restored: RestoredRun;
  registry: ToolRegistry;
  /** The live ledger re-run calls are recorded in. */
  ledger?: CallLedger;
  ids: { runId: string; agentName: string; instanceId: string };
  signal: AbortSignal;
  /** Given to tools with side effects instead of `signal`, as in a live run (see `RunControl.sideEffectSignal`). */
  sideEffectSignal?: AbortSignal;
  isUnattended: boolean;
  now(): number;
  emit(event: AigentEvent): void;
  gate?: ReconcileGate;
  /** The run is a dry run: (re-)run calls are simulated like any of its calls, and need no approval. */
  dryRun?: boolean;
  /** The run's toolResult checks for a settled call's result (restored or run again) before the model sees it. */
  guard?(executed: ExecutedToolCall): Promise<ExecutedToolCall>;
  /** Takes what each settled call did or would have done (the run's effect log and planned effects). */
  record?(executed: ExecutedToolCall): void;
  /**
   * With memory on: takes `memory` out of an interrupted call (a checkpointed response holds the calls as the model
   * sent them), so its tool, ledger entry and verify see the arguments a live call would.
   */
  takeMemory?(call: ToolCall): TakenMemory;
}

/**
 * The top-level calls of the round the run was in when it stopped: its response's calls when a checkpoint recorded
 * it, else the ledger's calls from the request that was in flight (the turn after the counted ones). Older ledger
 * entries belong to rounds already committed, or summarised away by a compaction, and are never replayed; later ones
 * (only with a stale checkpoint) belong to rounds the checkpoint never saw, which are not rebuilt either.
 */
function interruptedCalls(restored: RestoredRun): ToolCall[] {
  const { state: { inFlight, totals, context: { messages } }, ledger } = restored;
  const committed = new Set(messages.flatMap(({ message: { toolCallId } }) => (toolCallId == null ? [] : [toolCallId])));
  const fromLedger = (): ToolCall[] => ledger
    .filter(({ parentCallId, turn }) => parentCallId == null && turn === totals.turns + 1)
    .map(({ callId, tool, args }) => ({ id: callId, name: tool, args }));
  const calls = inFlight?.assistant.toolCalls ?? fromLedger();
  return calls.filter(({ id }) => !committed.has(id));
}

/** The thinking that opened the interrupted response: from the checkpoint, else as the ledger recorded it. */
function thinkingOf(params: { restored: RestoredRun; ids: ReadonlySet<string> }): ThinkingBlock[] {
  const { restored: { state: { inFlight }, ledger }, ids } = params;
  if (inFlight != null) return inFlight.assistant.thinkingBlocks ?? [];
  return ledger.find(({ callId, thinkingBlocks }) => ids.has(callId) && thinkingBlocks != null)?.thinkingBlocks ?? [];
}

/**
 * The messages that complete the round a run was interrupted in: its assistant message (from the checkpoint, or
 * rebuilt from the ledger) and one result per call. Finished calls reuse their recorded result; started ones follow
 * their tool's `resume` policy, and an `aigent_multi` call is settled call by call. Empty when the round was committed.
 */
export async function reconcileInterruptedRound(params: ReconcileParams): Promise<ReconciledRound> {
  const { restored, registry, emit, record, takeMemory, ...rest } = params;
  const { state: { inFlight, totals }, ledger } = restored;
  const calls = interruptedCalls(restored);
  if (calls.length === 0) return { messages: [], turn: totals.turns };
  const executed: ExecutedToolCall[] = [];
  for (const sentCall of calls) {
    const taken = takeMemory?.(sentCall);
    const call = taken?.call ?? sentCall;
    // A call in the ledger was admitted by the interrupted process, which queued its notes then: they are not saved
    // twice (a second save would count as a repeat and raise the note's confidence).
    const wasAdmitted = ledger.some(({ callId }) => callId === call.id);
    const settleParams = { ...rest, restored, registry, emit, call, ...(taken == null || wasAdmitted ? {} : { onAdmitted: taken.admit }) };
    const result = call.name === MULTI_TOOL_NAME ? await reconcileMulti(settleParams) : await reconcileCall({ ...settleParams, ledgerId: call.id });
    taken?.settle({ quietly: wasAdmitted });
    record?.(result);
    emit({ type: 'tool-result', callId: call.id, envelope: result.envelope });
    executed.push(result);
  }
  const ids = new Set(calls.map(({ id }) => id));
  const text = inFlight?.assistant.text ?? '';
  // The interrupted request counts as a turn even when no checkpoint recorded its response.
  const turn = Math.max(totals.turns, inFlight?.turn ?? 0, ...ledger.filter(({ callId }) => ids.has(callId)).map(({ turn: entryTurn }) => entryTurn));
  return { messages: turnMessages({ turn: { visible: text, calls, thinkingBlocks: thinkingOf({ restored, ids }) }, executed, registry }), turn };
}
