import type { GateOutcome } from '../approvals/approval-gate.js';
import { PREVIOUS_FIELD } from '../feedback/previous-outcome.js';
import type { ToolCall } from '../providers/provider-types.js';
import type { CallLedger } from '../resume/call-ledger.js';
import { reconcileInterruptedRound } from '../resume/reconcile-calls.js';
import type { ReconciledRound, RestoredRun } from '../resume/reconcile-calls.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { Tool, ToolContext } from '../tools/tool-types.js';
import type { AigentEvent } from './aigent-events.js';
import { COMMENTARY_TOOLS } from './dispatch-tool-call.js';
import { guardSettledCall } from './guard-settled-call.js';
import type { RunEffects } from './run-effects.js';
import type { RunGuardrails } from './run-guardrails.js';
import { nothingHeld } from './run-memory.js';
import type { RunTelemetry } from './run-turn.js';
import type { Clock } from './runtime-services.js';

/** The run's approval gate for one call, as the loop builds it. */
export type RunGate = (call: { call: ToolCall; tool: Tool; context: ToolContext; force?: { reason: string } }) => Promise<GateOutcome>;

export interface RestoreInterruptedRoundParams {
  restore: RestoredRun;
  telemetry: RunTelemetry;
  registry: ToolRegistry;
  ids: { runId: string; agentName: string; instanceId: string; ledgerRunId?: string };
  signal: AbortSignal;
  sideEffectSignal: AbortSignal;
  isUnattended: boolean;
  clock: Clock;
  emit(event: AigentEvent): void;
  ledger?: CallLedger;
  effects?: RunEffects;
  guardrails?: RunGuardrails;
  gate?: RunGate;
}

/**
 * Completes the round a resumed run was interrupted in, with the arguments a live dispatch would give each call's
 * tool (memory and feedback fields taken out), under the run's approvals, guardrails and dry-run settings.
 */
export function restoreInterruptedRound(params: RestoreInterruptedRoundParams): Promise<ReconciledRound> {
  const { restore, telemetry, registry, ids: { runId, agentName, instanceId, ledgerRunId }, signal, sideEffectSignal, isUnattended, clock, emit, ledger, effects, guardrails, gate } = params;
  const { memory } = telemetry;
  return reconcileInterruptedRound({
    // Bookkeeping tools carry no memory field, as in a live dispatch.
    ...(memory == null ? {} : { takeMemory: (call: ToolCall) => (COMMENTARY_TOOLS.has(call.name) ? nothingHeld(call) : memory.take(call)) }),
    // Feedback's previous is stripped as a live dispatch strips it; the interrupted process already linked it.
    ...(telemetry.feedback.isEnabled ? { injectedFields: (call: ToolCall) => (COMMENTARY_TOOLS.has(call.name) ? [] : [PREVIOUS_FIELD]) } : {}),
    restored: restore, registry, ids: { runId: ledgerRunId ?? runId, agentName, instanceId }, signal, sideEffectSignal, isUnattended, now: () => clock.now(), emit,
    ...(ledger == null ? {} : { ledger }), ...(effects == null ? {} : { dryRun: effects.dryRun, record: effects.record }), ...(guardrails == null ? {} : { guard: guardSettledCall(guardrails) }),
    ...(gate == null ? {} : { gate: ({ call, tool, force }: { call: ToolCall; tool: Tool; force?: { reason: string } }) => gate({ call, tool, context: { runId, agentName, instanceId, callId: call.id, signal }, ...(force == null ? {} : { force }) }) }),
  });
}
