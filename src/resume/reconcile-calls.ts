import type { AigentEvent } from '../core/aigent-events.js';
import type { NewContextMessage } from '../core/run-context.js';
import { turnMessages } from '../core/turn-messages.js';
import type { ToolCall } from '../providers/provider-types.js';
import { executeToolCall } from '../tools/execute-tool-call.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { ToolEnvelope } from '../tools/tool-envelope.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import { resumePolicyOf } from '../tools/tool-policies.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolContext } from '../tools/tool-types.js';
import { hashArgs, idempotencyKeyOf } from './call-ledger.js';
import type { CallLedger, LedgerEntry } from './call-ledger.js';
import type { RunState } from './checkpoint-types.js';

/** What a resumed run starts from: the latest checkpoint, the ledger and results that replace a call's own. */
export interface RestoredRun {
  state: RunState;
  ledger: LedgerEntry[];
  /** Call id → the envelope to give the model (e.g. the answers to a suspended `ask_user`). */
  overrides?: ReadonlyMap<string, ToolEnvelope>;
}

/** The completed round, and the number of turns the run had made once its request had been sent. */
export interface ReconciledRound {
  messages: NewContextMessage[];
  turn: number;
}

/** Asks whether an interrupted call with side effects may run again (the approval gate); false refuses it. */
export type AskToRerun = (params: { callId: string; tool: string; args: unknown }) => Promise<boolean>;

export interface ReconcileParams {
  restored: RestoredRun;
  registry: ToolRegistry;
  /** The live ledger re-run calls are recorded in. */
  ledger?: CallLedger;
  ids: { runId: string; agentName: string; instanceId: string };
  signal: AbortSignal;
  isUnattended: boolean;
  now(): number;
  emit(event: AigentEvent): void;
  askToRerun?: AskToRerun;
}

function restoredCall(envelope: ToolEnvelope): ExecutedToolCall {
  return { envelope, outcome: { success: envelope.ok, reason: 'restored from the call ledger' }, durationMs: 0, size: { resultBytes: 0, resultTokens: 0, truncated: false }, nested: [] };
}

function refused(params: { call: ToolCall; error: ToolErrorDetail }): ExecutedToolCall {
  const { call: { id, name }, error } = params;
  return restoredCall({ id, tool: name, ok: false, error });
}

function skippedError(call: ToolCall): ToolErrorDetail {
  return { category: 'denied', code: 'skipped', retryable: false, message: `Call '${call.id}' to '${call.name}' was interrupted by a restart and not run again (resume: skip)`, suggestion: 'Check whether its effect happened before relying on it, or call it again' };
}

function deniedError(call: ToolCall): ToolErrorDetail {
  return {
    category: 'denied', code: 'approval_denied', retryable: false,
    message: `Call '${call.id}' to '${call.name}' was interrupted by a restart and may already have had its effect; running it again needs approval, which was not given`,
    suggestion: 'Check whether the effect happened (e.g. read the target) before calling it again',
  };
}

/** The calls of the round the run was in when it stopped: its response's calls, else the ledger's uncommitted ones. */
function interruptedCalls(restored: RestoredRun): ToolCall[] {
  const { state: { inFlight, context: { messages } }, ledger } = restored;
  const committed = new Set(messages.flatMap(({ message: { toolCallId } }) => (toolCallId == null ? [] : [toolCallId])));
  const calls = inFlight?.assistant.toolCalls ?? ledger.map(({ callId, tool, args }) => ({ id: callId, name: tool, args }));
  return calls.filter(({ id }) => !committed.has(id));
}

/** Runs a call (again), recorded in the ledger first like any call. */
async function execute(params: ReconcileParams & { call: ToolCall }): Promise<ExecutedToolCall> {
  const { call, registry, ledger, ids, signal, now, emit, restored } = params;
  const turn = restored.state.totals.turns;
  emit({ type: 'tool-call', callId: call.id, name: call.name, args: call.args });
  const context: ToolContext = { ...ids, callId: call.id, signal, idempotencyKey: idempotencyKeyOf({ runId: ids.runId, callId: call.id }) };
  await ledger?.begin({ callId: call.id, tool: call.name, args: call.args, argsHash: hashArgs(call.args), turn });
  const executed = await executeToolCall({ registry, call, context, now });
  await ledger?.complete(call.id, executed.envelope).catch(() => undefined);
  return executed;
}

/** One interrupted call, by its ledger state and the tool's resume policy. */
async function reconcileCall(params: ReconcileParams & { call: ToolCall }): Promise<ExecutedToolCall> {
  const { call, restored: { ledger, overrides }, registry, isUnattended, askToRerun, ids, signal } = params;
  const override = overrides?.get(call.id);
  if (override != null) return restoredCall(override);
  const entry = ledger.find(({ callId }) => callId === call.id);
  // Finished calls are never executed again: the model gets what they returned.
  if (entry?.envelope != null && entry.status !== 'started') return restoredCall(entry.envelope);
  const tool = registry.get(call.name);
  // Never started (begin is written before a tool runs), or a tool that no longer exists: run it as a new call.
  if (entry == null || tool == null) return execute(params);
  const policy = resumePolicyOf(tool);
  if (policy === 'skip') return refused({ call, error: skippedError(call) });
  if (policy === 'verify' && tool.verify != null) {
    const verified = await tool.verify(call.args, { ...ids, callId: call.id, signal, idempotencyKey: entry.idempotencyKey });
    if (verified.done) {
      const envelope: ToolEnvelope = { id: call.id, tool: call.name, ok: true, result: verified.result ?? null };
      await params.ledger?.complete(call.id, envelope).catch(() => undefined);
      return restoredCall(envelope);
    }
    return execute(params);
  }
  if (policy === 'ask') {
    const isAllowed = !isUnattended && askToRerun != null && await askToRerun({ callId: call.id, tool: call.name, args: call.args });
    return isAllowed ? execute(params) : refused({ call, error: deniedError(call) });
  }
  return execute(params);
}

/**
 * The messages that complete the round a run was interrupted in: its assistant message (from the checkpoint, or
 * rebuilt from the ledger) and one result per call. Finished calls reuse their recorded result; started ones follow
 * their tool's `resume` policy. Empty when the round was already committed.
 */
export async function reconcileInterruptedRound(params: ReconcileParams): Promise<ReconciledRound> {
  const { restored: { state: { inFlight, totals }, ledger }, registry, emit } = params;
  const calls = interruptedCalls(params.restored);
  if (calls.length === 0) return { messages: [], turn: totals.turns };
  const executed: ExecutedToolCall[] = [];
  for (const call of calls) {
    const result = await reconcileCall({ ...params, call });
    emit({ type: 'tool-result', callId: call.id, envelope: result.envelope });
    executed.push(result);
  }
  const { text = '', thinkingBlocks = [] } = inFlight?.assistant ?? {};
  const ids = new Set(calls.map(({ id }) => id));
  // The interrupted request counts as a turn even when no checkpoint recorded its response.
  const turn = Math.max(totals.turns, inFlight?.turn ?? 0, ...ledger.filter(({ callId }) => ids.has(callId)).map(({ turn: entryTurn }) => entryTurn));
  return { messages: turnMessages({ turn: { visible: text, calls, thinkingBlocks }, executed, registry }), turn };
}
