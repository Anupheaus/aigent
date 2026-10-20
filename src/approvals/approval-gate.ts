import type { AigentEvent } from '../core/aigent-events.js';
import { createAigentError } from '../core/aigent-error.js';
import { describeError } from '../core/describe-value.js';
import type { Clock } from '../core/runtime-services.js';
import type { ToolCall } from '../providers/provider-types.js';
import { hashArgs } from '../resume/call-ledger.js';
import type { PendingApprovalState } from '../resume/checkpoint-types.js';
import { summariseArgs } from '../telemetry/summarise-args.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import type { Tool, ToolActivityView, ToolContext } from '../tools/tool-types.js';
import { decideByRules, needsApproval, ruleFromScope } from './approval-rules.js';
import type { ApprovalAuditRecord, ApprovalDecision, ApprovalOptions, ApprovalRule } from './approval-types.js';
import type { AuditTrail } from './audit-trail.js';

/** Whether a call may run, and why not. */
export type GateOutcome = { isAllowed: true } | { isAllowed: false; error: ToolErrorDetail };

export interface GateParams {
  /** The run id the request belongs to (the original run's when resumed). */
  runId: string;
  call: ToolCall;
  tool: Tool;
  context: ToolContext;
  isUnattended: boolean;
  /** The run signal: a stop while waiting refuses the call. */
  signal: AbortSignal;
  emit(event: AigentEvent): void;
  /** A resumed run asks before re-running an interrupted call, whatever the tool declares. */
  force?: { reason: string };
  /** Called once the request is pending (the run checkpoints it). */
  onPending?(): Promise<void>;
}

/** One agent instance's approvals: its pending requests and the decisions that resolve them. */
export interface ApprovalCenter {
  gate(params: GateParams): Promise<GateOutcome>;
  /** Resolves a pending request (or records the decision for a request a restored run will ask again). */
  approve(requestId: string, decision: ApprovalDecision): Promise<void>;
  /** Requests waiting for a decision, for one run or all. */
  pending(runId?: string): PendingApprovalState[];
  /** Requests a restored run still waits on, so `approve` before `resume` is accepted. */
  restorePending(params: { runId: string; states: readonly PendingApprovalState[] }): void;
}

export interface CreateApprovalCenterParams {
  rules: ApprovalOptions;
  /** `allow_always` rules, shared by the runtime's agents. */
  runtimeRules: ApprovalRule[];
  audit: AuditTrail;
  clock: Clock;
  agent: { name: string; instanceId: string };
}

interface Waiter {
  state: PendingApprovalState & { runId: string };
  resolve(decision: ApprovalDecision): void;
}

/** A sync view of the call for the request; renderers that wait on the outcome get a plain title instead. */
function activityOf(params: { tool: Tool; args: unknown }): ToolActivityView {
  const { tool, args } = params;
  const fallback = { title: `Call '${tool.name}'` };
  try {
    const view = tool.describeActivity(args, new Promise(() => undefined));
    return typeof view === 'object' && view != null && 'title' in view ? view : fallback;
  } catch {
    // A renderer that throws must not stop the request from being shown.
    return fallback;
  }
}

function denied(params: { tool: string; requestId: string; by: string; note?: string }): ToolErrorDetail {
  const { tool, requestId, by, note } = params;
  return {
    category: 'denied', code: 'approval_denied', retryable: false, details: { requestId, by },
    message: `The call to '${tool}' was not approved${by === 'policy' ? ' (no user is available to approve it in this run)' : ''}${note == null ? '' : `: ${note}`}`,
    suggestion: 'Do the task another way, or explain to the user what you wanted to do and why',
  };
}

/** Request ids are stable per call, so a restored run asking again finds a decision given before it resumed. */
export function approvalRequestId(params: { runId: string; callId: string }): string {
  return `apr_${params.runId}_${params.callId}`;
}

export function createApprovalCenter(params: CreateApprovalCenterParams): ApprovalCenter {
  const { rules, runtimeRules, audit, clock, agent } = params;
  const waiters = new Map<string, Waiter>();
  const restored = new Map<string, PendingApprovalState & { runId: string }>();
  const decided = new Map<string, ApprovalDecision>();

  const record = (entry: { requestId: string; runId: string; tool: string; args: unknown; decision: ApprovalAuditRecord['decision']; by: ApprovalAuditRecord['by']; note?: string }): Promise<void> => {
    const { args, ...rest } = entry;
    return audit.append({ ...rest, argsHash: hashArgs(args), agentName: agent.name, instanceId: agent.instanceId });
  };

  async function settleDecision(params: { gate: GateParams; requestId: string; decision: ApprovalDecision }): Promise<GateOutcome> {
    const { gate: { call, emit }, requestId, decision: { decision, scope, note } } = params;
    emit({ type: 'approval-decision', requestId, callId: call.id, tool: call.name, decision, by: 'user', ...(note == null ? {} : { note }) });
    if (decision === 'allow_always') runtimeRules.push(ruleFromScope({ tool: call.name, ...(scope == null ? {} : { scope }) }));
    return decision === 'deny' ? { isAllowed: false, error: denied({ tool: call.name, requestId, by: 'user', ...(note == null ? {} : { note }) }) } : { isAllowed: true };
  }

  async function ask(params: { gate: GateParams; requestId: string }): Promise<GateOutcome> {
    const { gate, requestId } = params;
    const { runId, call, tool, signal, emit, force, onPending } = gate;
    const reason = force?.reason ?? (typeof tool.requiresApproval === 'object' ? tool.requiresApproval.reason : undefined);
    const state: PendingApprovalState & { runId: string } = { runId, requestId, callId: call.id, tool: call.name, args: call.args, requestedAt: clock.now(), ...(tool.risk == null ? {} : { risk: tool.risk }), ...(reason == null ? {} : { reason }) };
    const decision = new Promise<ApprovalDecision | undefined>(resolve => {
      const onAbort = (): void => finish(undefined);
      // Either way the listener goes, so a long run does not collect one per request.
      const finish = (given: ApprovalDecision | undefined): void => { signal.removeEventListener('abort', onAbort); resolve(given); };
      waiters.set(requestId, { state, resolve: finish });
      if (signal.aborted) finish(undefined);
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    emit({ type: 'approval-request', requestId, callId: call.id, tool: call.name, argsSummary: summariseArgs({ args: call.args, captureContent: true }), activity: activityOf({ tool, args: call.args }), ...(state.risk == null ? {} : { risk: state.risk }), ...(reason == null ? {} : { reason }) });
    // The request still waits (a person may answer it), but a restart would lose it: the caller is told.
    await onPending?.().catch((error: unknown) => emit({ type: 'warning', message: `Approval request '${requestId}' could not be checkpointed, so it will not survive a restart: ${describeError(error)}` }));
    const given = await decision;
    waiters.delete(requestId);
    if (given != null) return settleDecision({ gate, requestId, decision: given });
    await record({ requestId, runId, tool: call.name, args: call.args, decision: 'aborted', by: 'policy' }).catch(() => undefined);
    emit({ type: 'approval-decision', requestId, callId: call.id, tool: call.name, decision: 'deny', by: 'policy', note: 'the run was stopped' });
    return { isAllowed: false, error: { category: 'aborted', code: 'approval_aborted', retryable: false, message: `The run was stopped while the call to '${call.name}' waited for approval`, details: { requestId } } };
  }

  async function gate(params: GateParams): Promise<GateOutcome> {
    const { runId, call, tool, context, isUnattended, emit, force } = params;
    if (force == null && !needsApproval({ requiresApproval: tool.requiresApproval, args: call.args, context })) return { isAllowed: true };
    const requestId = approvalRequestId({ runId, callId: call.id });
    const early = decided.get(requestId);
    if (early != null) { decided.delete(requestId); return settleDecision({ gate: params, requestId, decision: early }); }
    const verdict = decideByRules({ tool: call.name, args: call.args, rules: { allow: [...rules.allow ?? [], ...runtimeRules], deny: rules.deny ?? [] } });
    if (verdict !== 'ask' || isUnattended) {
      const by = verdict === 'ask' ? 'policy' : 'rule';
      const isAllowed = verdict === 'allow';
      await record({ requestId, runId, tool: call.name, args: call.args, decision: isAllowed ? 'allow_once' : verdict === 'deny' ? 'deny' : 'denied_unattended', by }).catch(() => undefined);
      emit({ type: 'approval-decision', requestId, callId: call.id, tool: call.name, decision: isAllowed ? 'allow_once' : 'deny', by });
      return isAllowed ? { isAllowed: true } : { isAllowed: false, error: denied({ tool: call.name, requestId, by }) };
    }
    return ask({ gate: params, requestId });
  }

  async function approve(requestId: string, decision: ApprovalDecision): Promise<void> {
    const waiter = waiters.get(requestId);
    const state = waiter?.state ?? restored.get(requestId);
    if (state == null) {
      throw createAigentError({ code: 'invalid_input', message: `No approval request '${requestId}' is pending for agent instance '${agent.instanceId}'`, details: { requestId, pending: [...waiters.keys(), ...restored.keys()] } });
    }
    restored.delete(requestId);
    if (waiter == null) decided.set(requestId, decision);
    else { waiters.delete(requestId); waiter.resolve(decision); }
    await record({ requestId, runId: state.runId, tool: state.tool, args: state.args, decision: decision.decision, by: 'user', ...(decision.note == null ? {} : { note: decision.note }) });
  }

  return {
    gate, approve,
    pending: runId => [...waiters.values()].filter(({ state }) => runId == null || state.runId === runId).map(({ state: { runId: _runId, ...rest } }) => rest),
    restorePending: ({ runId, states }) => { for (const state of states) restored.set(state.requestId, { ...state, runId }); },
  };
}
