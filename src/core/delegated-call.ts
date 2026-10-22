import type { DelegatedToolResult, ToolCall } from '../providers/provider-types.js';
import { envelopeText } from '../tools/envelope-text.js';
import { createAigentError } from './aigent-error.js';
import { dispatchToolCall } from './dispatch-tool-call.js';
import type { RunTurnParams } from './run-turn.js';

/**
 * Delegated mode: one call the provider's own loop asks for, run through the same dispatch path as a streamed call
 * (budget, guardrails, approvals, ledger, cache, dry runs, telemetry), awaited so the provider can continue with its
 * result. The call joins the turn's calls, marked as already answered inside the stream.
 */
export async function runDelegatedCall(params: { call: ToolCall; turn: RunTurnParams }): Promise<DelegatedToolResult> {
  const { turn } = params;
  const { work: { partial, executions }, totals, callIds } = turn;
  const call = callIds?.unique({ call: params.call, turn: totals.turns }) ?? params.call;
  partial.calls.push(call);
  partial.delegatedCallIds.push(call.id);
  const queued = executions.length;
  dispatchToolCall({ call, turn });
  // dispatchToolCall queues exactly one execution per call, synchronously, whatever it decides.
  const execution = executions[queued];
  if (execution == null) throw createAigentError({ code: 'provider_failed', message: `Delegated call '${call.id}' (${call.name}) was not dispatched`, details: { callId: call.id } });
  const { envelope } = await execution;
  return { callId: call.id, text: envelopeText(envelope), isError: !envelope.ok };
}
