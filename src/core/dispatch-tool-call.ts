import { FEEDBACK_TOOL_NAME } from '../feedback/feedback-tool.js';
import { ASK_USER_TOOL_NAME } from './ask-user-name.js';
import { PLAN_COMPLETE_TOOL_NAME } from '../planning/plan-complete-tool.js';
import { TODO_TOOL_NAME } from '../planning/todo-tool.js';
import type { ToolCall } from '../providers/provider-types.js';
import type { FinishStep } from '../telemetry/trace-recorder.js';
import { executeToolCall, rejectToolCall } from '../tools/execute-tool-call.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import { MULTI_TOOL_NAME } from '../tools/multi-tool.js';
import { parseToolArgs } from '../tools/parse-tool-args.js';
import { startToolActivity } from '../tools/run-tool-activity.js';
import { describeThrown } from '../tools/tool-error-detail.js';
import type { InnerCall, InnerCallVerdict, MultiToolContext, ToolContext } from '../tools/tool-types.js';
import { hashArgs, idempotencyKeyOf } from '../resume/call-ledger.js';
import type { CallLedger } from '../resume/call-ledger.js';
import type { ExecuteToolCallParams } from '../tools/execute-tool-call.js';
import type { GateOutcome } from '../approvals/approval-gate.js';
import { describeError } from './describe-value.js';
import { expandCallAliases } from './expand-call-aliases.js';
import { linkPrevious, stripMultiPrevious } from './link-previous.js';
import { shapeWith } from './run-shaping.js';
import type { RunTotals, RunTurnParams } from './run-turn.js';
import type { CallVerdict } from './run-guardrails.js';

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
  if (totals.toolCalls >= maxToolCalls) return false;
  totals.toolCalls += 1;
  return true;
}

/** The aigent_multi context: inner calls share the run's call budget and are traced as steps of their own. */
function multiToolContext(params: { context: ToolContext; turn: RunTurnParams; parentCallId: string }): MultiToolContext {
  const { context, turn: { totals, maxToolCalls, telemetry: { recorder }, guardrails }, parentCallId } = params;
  const toInner = (verdict: CallVerdict): InnerCallVerdict => ('error' in verdict ? verdict : { args: verdict.call.args });
  return {
    ...context,
    reserveToolCall: () => reserveToolCall({ totals, maxToolCalls }),
    traceInnerCall: ({ id, tool, args }) => recorder.begin({ turn: totals.turns, callId: id, parentCallId, tool, args }),
    ...(guardrails == null ? {} : {
      checkInnerCall: ({ id, tool, args }: InnerCall): InnerCallVerdict | Promise<InnerCallVerdict> => {
        const verdict = guardrails.checkToolCall({ id, name: tool, args });
        return verdict instanceof Promise ? verdict.then(toInner) : toInner(verdict);
      },
    }),
  };
}

/**
 * Runs the call, recorded in the ledger first when there is one: the `started` entry is stored before the tool runs,
 * so a resumed run never runs a finished call again. A call whose start cannot be recorded is not run.
 */
async function runLedgered(params: { execute: ExecuteToolCallParams; ledger?: CallLedger; turn: number; gate?(): Promise<GateOutcome> }): Promise<ExecutedToolCall> {
  const { execute, ledger, turn, gate } = params;
  const { call } = execute;
  // Approval comes first: a refused call never starts, so it is never in the ledger.
  const approval = await gate?.();
  if (approval?.isAllowed === false) return rejectToolCall({ call, error: approval.error });
  if (ledger == null) return executeToolCall(execute);
  try {
    await ledger.begin({ callId: call.id, tool: call.name, args: call.args, argsHash: hashArgs(call.args), turn });
  } catch (error) {
    return rejectToolCall({ call, error: { category: 'denied', code: 'ledger_unavailable', retryable: true, message: `The call was not run because its start could not be recorded: ${describeError(error)}` } });
  }
  const executed = await executeToolCall(execute);
  // The effect happened either way; a lost `done` only means a resume treats the call by its resume policy.
  await ledger.complete(call.id, executed.envelope).catch(() => undefined);
  return executed;
}

/** Starts (or refuses, past the limit) one tool call without waiting for it, so tools overlap with generation. */
export function dispatchToolCall(params: DispatchParams): void {
  const { turn } = params;
  const { runId, agentName, instanceId, registry, maxToolCalls, clock, signal, totals, work, telemetry, cache, emit } = turn;
  const { shaping } = turn;
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
  if (!isCommentary && totals.toolCalls >= maxToolCalls) {
    const error = { category: 'denied', code: 'tool_call_limit', retryable: false, message: `Tool call limit of ${maxToolCalls} reached` } as const;
    work.executions.push(Promise.resolve(rejectToolCall({ call, error })).then(reportNotRun));
    return;
  }

  // Side-effecting tools outlive an unforced immediate stop, so a write is never left half-done.
  const toolSignal = registry.get(name)?.hasSideEffects === true ? turn.sideEffectSignal : signal;
  const ledgerRunId = turn.ledgerRunId ?? runId;
  const isDryRun = effects?.dryRun === true;
  const baseContext: ToolContext = { agentName, instanceId, runId, callId, signal: toolSignal, idempotencyKey: idempotencyKeyOf({ runId: ledgerRunId, callId }), ...(isDryRun ? { dryRun: true } : {}) };
  let context: ToolContext = baseContext;
  if (name === MULTI_TOOL_NAME) {
    // The aigent_multi wrapper is not counted itself: each inner call takes from the shared budget instead.
    context = multiToolContext({ context: baseContext, turn, parentCallId: callId });
  } else if (!isCommentary) {
    totals.toolCalls += 1;
  }
  const tool = registry.get(name);
  const parsed = tool == null ? undefined : parseToolArgs(tool.argsSchema, args);
  const isRunnable = tool != null && parsed != null && parsed.ok;
  const { approve } = turn;
  // executeToolCall promises never to reject; this last-resort guard keeps a broken promise from failing the run or going unhandled.
  // Bookkeeping tools only change run state, which the checkpoint holds; ask_user is ledgered so a suspended turn can resume.
  const ledger = isCommentary && name !== ASK_USER_TOOL_NAME ? undefined : turn.ledger;
  const start = (verdict: CallVerdict): Promise<ExecutedToolCall> => {
    if ('error' in verdict) return Promise.resolve(rejectToolCall({ call, error: verdict.error }));
    const checked = verdict.call;
    return runLedgered({
      // A simulated (or refused) call changes nothing, so there is nothing for a person to approve.
      ...(approve == null || !isRunnable || (isDryRun && tool.hasSideEffects) ? {} : { gate: () => approve({ call: checked, tool, context }) }),
      execute: {
        registry, call: checked, context, now: () => clock.now(),
        ...(cache == null ? {} : { cache }),
        ...(shaping == null ? {} : { shape: shapeWith(shaping) }),
      },
      turn: totals.turns, ...(ledger == null ? {} : { ledger }),
    });
  };
  // Guardrails see work calls only (bookkeeping tools change run state, nothing else); a block means the call never runs.
  const isGuarded = guardrails != null && isRunnable && !isCommentary;
  const verdict: CallVerdict | Promise<CallVerdict> = isGuarded ? guardrails.checkToolCall(call) : { call };
  const execution = (verdict instanceof Promise ? verdict.then(start) : start(verdict))
    .then(executed => (isGuarded ? guardrails.checkToolResult(executed) : executed))
    .catch((error: unknown) => rejectToolCall({ call, error: describeThrown(error) }));

  if (tool == null || parsed == null || !parsed.ok) {
    // Unknown tool or invalid arguments: executeToolCall refuses it without running anything.
    work.executions.push(execution.then(reportNotRun));
    return;
  }
  work.executions.push(execution.then(reportResult));
  const outcome = execution.then(executed => executed.outcome);
  work.activities.push(startToolActivity({ tool, args: parsed.value, callId, outcome, signal: work.activityController.signal, emit }));
}
