import { FEEDBACK_TOOL_NAME } from '../feedback/feedback-tool.js';
import { ASK_USER_TOOL_NAME } from './ask-user-name.js';
import { PLAN_COMPLETE_TOOL_NAME } from '../planning/plan-complete-tool.js';
import { TODO_TOOL_NAME } from '../planning/todo-tool.js';
import type { ToolCall } from '../providers/provider-types.js';
import type { FinishStep } from '../telemetry/trace-recorder.js';
import { rejectToolCall } from '../tools/execute-tool-call.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import { MULTI_TOOL_NAME, nestedMultiError } from '../tools/multi-tool.js';
import { parseToolArgs } from '../tools/parse-tool-args.js';
import { startToolActivity } from '../tools/run-tool-activity.js';
import type { InnerCall, MultiToolContext, ToolContext } from '../tools/tool-types.js';
import { idempotencyKeyOf, innerLedgerId } from '../resume/call-ledger.js';
import { expandCallAliases } from './expand-call-aliases.js';
import { linkPrevious, stripMultiPrevious } from './link-previous.js';
import { runDispatchedCall } from './run-dispatched-call.js';
import { delegationFor, toolCallsCommitted } from './delegation-context.js';
import type { RunTotals, RunTurnParams } from './run-turn.js';

/**
 * Bookkeeping, not work: `aigent_feedback`, `plan_complete`, `todo` and `ask_user` are never refused for the budget,
 * never counted against it, carry no `previous` and never receive outcomes.
 */
export const COMMENTARY_TOOLS: ReadonlySet<string> = new Set([FEEDBACK_TOOL_NAME, PLAN_COMPLETE_TOOL_NAME, TODO_TOOL_NAME, ASK_USER_TOOL_NAME]);

/** `ask_user` without a user (unattended, or a task without `onQuestion`): refused, so the ambiguity policy applies. */
const NO_USER_ERROR = {
  category: 'denied', code: 'no_user', retryable: false,
  message: 'No user is available to answer questions in this run; make a reasonable assumption and state it, as the brief says',
} as const;

interface ReserveToolCallParams {
  totals: RunTotals;
  maxToolCalls: number;
}

interface DispatchParams {
  call: ToolCall;
  turn: RunTurnParams;
}

/**
 * The call as the tool sees it: with feedback on, `previous` is taken out (and linked to the prior step) first, and
 * out of `aigent_multi` inner calls too, where it is ignored.
 */
function withoutPrevious(params: DispatchParams): ToolCall {
  const { call, turn: { totals, telemetry: { recorder, feedback }, emit } } = params;
  if (!feedback.isEnabled || COMMENTARY_TOOLS.has(call.name)) return call;
  const topLevel = { ...call, args: linkPrevious({ call, turn: totals.turns, recorder, feedback, emit }) };
  return call.name === MULTI_TOOL_NAME ? { ...topLevel, args: stripMultiPrevious({ call: topLevel, emit }) } : topLevel;
}

/** Takes one call from the run's `maxToolCalls` budget; false once it is spent. */
function reserveToolCall(params: ReserveToolCallParams): boolean {
  const { totals, maxToolCalls } = params;
  // Delegated sub-runs' calls (finished or reserved) count against the same budget.
  if (toolCallsCommitted(totals) >= maxToolCalls) return false;
  totals.toolCalls += 1;
  return true;
}

/**
 * The aigent_multi context: each inner call takes the same path as a top-level call (guardrails, the shared budget,
 * approvals, its own ledger entry and idempotency key, the cache, dry runs) and is traced as a step of its own.
 */
function multiToolContext(params: { context: ToolContext; turn: RunTurnParams; parentCallId: string }): MultiToolContext {
  const { context, turn, parentCallId } = params;
  const { totals, maxToolCalls, telemetry: { recorder }, registry, signal, sideEffectSignal } = turn;
  const runInnerCall = async ({ id, tool, args }: InnerCall): Promise<ExecutedToolCall> => {
    const call = { id, name: tool, args };
    const finish = recorder.begin({ turn: totals.turns, callId: id, parentCallId, tool, args });
    const ledgerId = innerLedgerId({ parentCallId, innerId: id });
    const toolSignal = registry.get(tool)?.hasSideEffects === true ? sideEffectSignal : signal;
    const delegation = registry.get(tool)?.startsSubRuns === true ? delegationFor({ turn, callId: ledgerId }) : undefined;
    const { delegation: _wrapperDelegation, ...wrapperContext } = context;
    const innerContext: ToolContext = { ...wrapperContext, callId: id, signal: toolSignal, idempotencyKey: idempotencyKeyOf({ runId: turn.ledgerRunId ?? turn.runId, callId: ledgerId }), ...(delegation == null ? {} : { delegation }) };
    const executed = tool === MULTI_TOOL_NAME
      ? rejectToolCall({ call, error: nestedMultiError() })
      : await runDispatchedCall({ call, turn, context: innerContext, ledgerId, parentCallId, isCommentary: COMMENTARY_TOOLS.has(tool), isLedgered: true, reserve: () => reserveToolCall({ totals, maxToolCalls }) });
    finish(executed);
    return executed;
  };
  return { ...context, runInnerCall };
}

/** Starts (or refuses, past the limit) one tool call without waiting for it, so tools overlap with generation. */
export function dispatchToolCall(params: DispatchParams): void {
  const { turn } = params;
  const { runId, agentName, instanceId, registry, maxToolCalls, signal, totals, work, telemetry, emit, shaping } = turn;
  const stripped = withoutPrevious(params);
  // Aliases are expanded (for tools that accept them) before anything sees the arguments, so keys, validation and traces use the full text.
  const call = shaping == null ? stripped : expandCallAliases({ call: stripped, registry, aliases: shaping.state.aliases });
  const { id: callId, name, args } = call;
  emit({ type: 'tool-call', callId, name, args });
  const finishStep: FinishStep = telemetry.recorder.begin({ turn: totals.turns, callId, tool: name, args });
  const { guardrails, effects } = turn;
  const reportResult = (executed: ExecutedToolCall): ExecutedToolCall => {
    const decisions = guardrails?.decisions.filter(decision => decision.callId === callId) ?? [];
    finishStep(decisions.length === 0 ? executed : { ...executed, guardrails: decisions });
    effects?.record(executed);
    emit({ type: 'tool-result', callId, envelope: executed.envelope });
    return executed;
  };
  // Calls that never run have no renderer, but a UI still needs a row for them saying why.
  const reportNotRun = (executed: ExecutedToolCall): ExecutedToolCall => {
    const { envelope } = executed;
    const detail = envelope.ok ? undefined : envelope.error.message;
    emit({ type: 'tool-activity', callId, view: { title: `Call to '${name}' was not run`, ...(detail != null ? { detail } : {}) } });
    return reportResult(executed);
  };

  // aigent_feedback is commentary, not work: it is never refused for the budget and never counted against it, so
  // reporting feedback cannot starve real calls or inflate usage.toolCalls and toolCallsPerTurn.
  const isCommentary = COMMENTARY_TOOLS.has(name);
  if (name === ASK_USER_TOOL_NAME && registry.get(name) == null) {
    work.executions.push(Promise.resolve(rejectToolCall({ call, error: NO_USER_ERROR })).then(reportNotRun));
    return;
  }
  if (!isCommentary && toolCallsCommitted(totals) >= maxToolCalls) {
    const error = { category: 'denied', code: 'tool_call_limit', retryable: false, message: `Tool call limit of ${maxToolCalls} reached` } as const;
    work.executions.push(Promise.resolve(rejectToolCall({ call, error })).then(reportNotRun));
    return;
  }

  // Side-effecting tools outlive an unforced immediate stop, so a write is never left half-done.
  const toolSignal = registry.get(name)?.hasSideEffects === true ? turn.sideEffectSignal : signal;
  const delegation = registry.get(name)?.startsSubRuns === true ? delegationFor({ turn, callId }) : undefined;
  const baseContext: ToolContext = {
    agentName, instanceId, runId, callId, signal: toolSignal, idempotencyKey: idempotencyKeyOf({ runId: turn.ledgerRunId ?? runId, callId }),
    ...(effects?.dryRun === true ? { dryRun: true } : {}), ...(delegation == null ? {} : { delegation }),
  };
  let context: ToolContext = baseContext;
  if (name === MULTI_TOOL_NAME) {
    // The aigent_multi wrapper is not counted itself: each inner call takes from the shared budget instead.
    context = multiToolContext({ context: baseContext, turn, parentCallId: callId });
  } else if (!isCommentary) {
    totals.toolCalls += 1;
  }
  const tool = registry.get(name);
  const parsed = tool == null ? undefined : parseToolArgs(tool.argsSchema, args);
  // Bookkeeping tools only change run state, which the checkpoint holds; ask_user is ledgered so a suspended turn can resume.
  const isLedgered = !isCommentary || name === ASK_USER_TOOL_NAME;
  const execution = runDispatchedCall({ call, turn, context, ledgerId: callId, isCommentary, isLedgered });

  if (tool == null || parsed == null || !parsed.ok) {
    // Unknown tool or invalid arguments: executeToolCall refuses it without running anything.
    work.executions.push(execution.then(reportNotRun));
    return;
  }
  work.executions.push(execution.then(reportResult));
  const outcome = execution.then(executed => executed.outcome);
  work.activities.push(startToolActivity({ tool, args: parsed.value, callId, outcome, signal: work.activityController.signal, emit }));
}
