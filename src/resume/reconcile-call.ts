import { describeError } from '../core/describe-value.js';
import type { ToolCall } from '../providers/provider-types.js';
import { executeToolCall } from '../tools/execute-tool-call.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { ToolEnvelope } from '../tools/tool-envelope.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import { resumePolicyOf } from '../tools/tool-policies.js';
import type { Tool, ToolContext } from '../tools/tool-types.js';
import { hashArgs, idempotencyKeyOf } from './call-ledger.js';
import type { ReconcileParams } from './reconcile-calls.js';

/** One call to settle: a top-level call, or an `aigent_multi` inner call (whose ledger id is `<parent>:<inner>`). */
export interface ReconcileCallParams extends ReconcileParams {
  /** The call as its tool sees it; envelopes carry its id. */
  call: ToolCall;
  /** Its id in the ledger, idempotency key and approval request. */
  ledgerId: string;
  parentCallId?: string;
}

/** Why an interrupted call with side effects needs approval before it runs again. */
const RERUN_REASON = 'The call was interrupted by a restart and may already have had its effect; running it again could repeat it';

export function restoredCall(envelope: ToolEnvelope): ExecutedToolCall {
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

/** A store or tool failure while settling a call: the model is told, the run goes on (it never rejects). */
function unavailable(params: { call: ToolCall; what: string; error: unknown }): ExecutedToolCall {
  const { call, what, error } = params;
  return refused({ call, error: { category: 'denied', code: 'ledger_unavailable', retryable: true, message: `Call '${call.id}' to '${call.name}' was not settled after the restart: ${what} failed: ${describeError(error)}` } });
}

/** The context the call's tool sees: the same key as its first execution, and the signal a live run would give it. */
function contextOf(params: ReconcileCallParams & { tool?: Tool }): ToolContext {
  const { call, ledgerId, ids, signal, sideEffectSignal, tool, dryRun } = params;
  const toolSignal = tool?.hasSideEffects === true && sideEffectSignal != null ? sideEffectSignal : signal;
  // A resumed dry run stays a dry run: its mutating calls are simulated, never run for real.
  return { ...ids, callId: call.id, signal: toolSignal, idempotencyKey: idempotencyKeyOf({ runId: ids.runId, callId: ledgerId }), ...(dryRun === true ? { dryRun: true } : {}) };
}

/** Runs a call (again), recorded in the ledger first like any call. */
async function execute(params: ReconcileCallParams & { tool?: Tool }): Promise<ExecutedToolCall> {
  const { call, ledgerId, parentCallId, registry, ledger, now, emit, restored } = params;
  if (parentCallId == null) emit({ type: 'tool-call', callId: call.id, name: call.name, args: call.args });
  try {
    await ledger?.begin({ callId: ledgerId, tool: call.name, args: call.args, argsHash: hashArgs(call.args), turn: restored.state.totals.turns, ...(parentCallId == null ? {} : { parentCallId }) });
  } catch (error) {
    return unavailable({ call, what: 'recording its start', error });
  }
  const executed = await executeToolCall({ registry, call, context: contextOf(params), now });
  await ledger?.complete(ledgerId, executed.envelope).catch(() => undefined);
  return executed;
}

/** Runs the call (again) once the approval gate allows it; refused calls get the gate's result. */
async function gated(params: ReconcileCallParams & { tool?: Tool; force?: { reason: string } }): Promise<ExecutedToolCall> {
  const { call, ledgerId, tool, force, gate, dryRun } = params;
  // A simulated call changes nothing, so there is nothing for a person to approve (as in a live dry run).
  if (dryRun === true && tool?.hasSideEffects === true) return execute(params);
  if (tool != null && gate != null) {
    // The request is keyed by the ledger id, like the request the live run made for this call.
    const outcome = await gate({ call: { ...call, id: ledgerId }, tool, ...(force == null ? {} : { force }) });
    if (!outcome.isAllowed) return refused({ call, error: outcome.error });
  } else if (force != null) {
    // No gate (or no user in an unattended run): nobody can approve running it again.
    return refused({ call, error: deniedError(call) });
  }
  return execute(params);
}

/** One interrupted call, by its ledger state and the tool's resume policy. */
export async function reconcileCall(params: ReconcileCallParams): Promise<ExecutedToolCall> {
  const { call, ledgerId, restored: { ledger, overrides }, registry } = params;
  const override = overrides?.get(ledgerId);
  if (override != null) return restoredCall(override);
  const entry = ledger.find(({ callId }) => callId === ledgerId);
  // Finished calls are never executed again: the model gets what they returned.
  if (entry?.envelope != null && entry.status !== 'started') return restoredCall({ ...entry.envelope, id: call.id });
  const tool = registry.get(call.name);
  // Never started (begin is written before a tool runs), or a tool that no longer exists: run it as a new call.
  if (entry == null || tool == null) return gated({ ...params, ...(tool == null ? {} : { tool }) });
  const policy = resumePolicyOf(tool);
  if (policy === 'skip') return refused({ call, error: skippedError(call) });
  if (policy === 'verify' && tool.verify != null) {
    let verified;
    try {
      verified = await tool.verify(call.args, { ...contextOf({ ...params, tool }), idempotencyKey: entry.idempotencyKey });
    } catch (error) {
      return unavailable({ call, what: 'its verify', error });
    }
    if (verified.done) {
      const envelope: ToolEnvelope = { id: call.id, tool: call.name, ok: true, result: verified.result ?? null };
      await params.ledger?.complete(ledgerId, envelope).catch(() => undefined);
      return restoredCall(envelope);
    }
    return gated({ ...params, tool });
  }
  return gated({ ...params, tool, ...(policy === 'ask' ? { force: { reason: RERUN_REASON } } : {}) });
}
