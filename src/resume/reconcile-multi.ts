import type { ToolCall } from '../providers/provider-types.js';
import { rejectToolCall } from '../tools/execute-tool-call.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import { MULTI_TOOL_NAME, nestedMultiError } from '../tools/multi-tool.js';
import { parseToolArgs } from '../tools/parse-tool-args.js';
import type { ToolEnvelope } from '../tools/tool-envelope.js';
import { innerLedgerId } from './call-ledger.js';
import { reconcileCall, restoredCall } from './reconcile-call.js';
import type { ReconcileParams } from './reconcile-calls.js';

interface InnerCallArgs {
  calls: { id: string; tool: string; args: unknown }[];
}

/**
 * An interrupted `aigent_multi` call. The wrapper itself has no effect, so it has no resume policy of its own: a
 * finished wrapper gives back its recorded result, otherwise each inner call is settled by its own ledger entry and
 * its own tool's policy (so a finished inner side effect never runs again), and the wrapper result is rebuilt.
 */
export async function reconcileMulti(params: ReconcileParams & { call: ToolCall; onAdmitted?(): void }): Promise<ExecutedToolCall> {
  // The wrapper's own admission: never passed on, its inner calls carry no memory.
  const { onAdmitted, ...innerParams } = params;
  const { call, restored: { ledger }, registry } = params;
  const entry = ledger.find(({ callId }) => callId === call.id);
  if (entry?.envelope != null && entry.status !== 'started') return { ...restoredCall(entry.envelope), ...(entry.effects == null ? {} : { effects: entry.effects }) };
  const multi = registry.get(MULTI_TOOL_NAME);
  const parsed = multi == null ? undefined : parseToolArgs(multi.argsSchema, call.args);
  if (parsed == null || !parsed.ok) {
    return rejectToolCall({ call, error: { category: 'validation', code: 'invalid_arguments', retryable: true, message: `The interrupted '${MULTI_TOOL_NAME}' call '${call.id}' could not be settled: its arguments are not valid any more` } });
  }
  const { calls } = parsed.value as InnerCallArgs;
  onAdmitted?.();
  const envelopes: ToolEnvelope[] = [];
  const settledCalls: ExecutedToolCall[] = [];
  // One at a time, in call order: each may ask for approval, and the order keeps the outcome deterministic.
  for (const inner of calls) {
    const innerCall: ToolCall = { id: inner.id, name: inner.tool, args: inner.args };
    const settled = inner.tool === MULTI_TOOL_NAME
      ? rejectToolCall({ call: innerCall, error: nestedMultiError() })
      : await reconcileCall({ ...innerParams, call: innerCall, ledgerId: innerLedgerId({ parentCallId: call.id, innerId: inner.id }), parentCallId: call.id });
    envelopes.push(settled.envelope);
    settledCalls.push(settled);
  }
  const envelope: ToolEnvelope = { id: call.id, tool: MULTI_TOOL_NAME, ok: true, result: envelopes };
  if (entry != null) await params.ledger?.complete(call.id, { envelope }).catch(() => undefined);
  // What the inner calls did (or would have done) belongs to the wrapper, as in a live run.
  const plannedEffects = settledCalls.flatMap(({ plannedEffects: planned = [] }) => planned);
  const effects = settledCalls.flatMap(({ effects: captured = [] }) => captured);
  return { ...restoredCall(envelope), ...(plannedEffects.length === 0 ? {} : { plannedEffects }), ...(effects.length === 0 ? {} : { effects }) };
}
