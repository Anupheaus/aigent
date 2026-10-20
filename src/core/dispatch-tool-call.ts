import { FEEDBACK_TOOL_NAME } from '../feedback/feedback-tool.js';
import type { ToolCall } from '../providers/provider-types.js';
import type { FinishStep } from '../telemetry/trace-recorder.js';
import { executeToolCall, rejectToolCall } from '../tools/execute-tool-call.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import { MULTI_TOOL_NAME } from '../tools/multi-tool.js';
import { parseToolArgs } from '../tools/parse-tool-args.js';
import { startToolActivity } from '../tools/run-tool-activity.js';
import { describeThrown } from '../tools/tool-error-detail.js';
import type { MultiToolContext, ToolContext } from '../tools/tool-types.js';
import { linkPrevious, stripMultiPrevious } from './link-previous.js';
import type { RunTotals, RunTurnParams } from './run-turn.js';

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
  if (!feedback.isEnabled || call.name === FEEDBACK_TOOL_NAME) return call;
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
  const { context, turn: { totals, maxToolCalls, telemetry: { recorder } }, parentCallId } = params;
  return {
    ...context,
    reserveToolCall: () => reserveToolCall({ totals, maxToolCalls }),
    traceInnerCall: ({ id, tool, args }) => recorder.begin({ turn: totals.turns, callId: id, parentCallId, tool, args }),
  };
}

/** Starts (or refuses, past the limit) one tool call without waiting for it, so tools overlap with generation. */
export function dispatchToolCall(params: DispatchParams): void {
  const { turn } = params;
  const { runId, agentName, instanceId, registry, maxToolCalls, clock, signal, totals, work, telemetry, emit } = turn;
  const call = withoutPrevious(params);
  const { id: callId, name, args } = call;
  emit({ type: 'tool-call', callId, name, args });
  const finishStep: FinishStep = telemetry.recorder.begin({ turn: totals.turns, callId, tool: name, args });
  const reportResult = (executed: ExecutedToolCall): ExecutedToolCall => {
    finishStep(executed);
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
  const isCommentary = name === FEEDBACK_TOOL_NAME;
  if (!isCommentary && totals.toolCalls >= maxToolCalls) {
    const error = { category: 'denied', code: 'tool_call_limit', retryable: false, message: `Tool call limit of ${maxToolCalls} reached` } as const;
    work.executions.push(Promise.resolve(rejectToolCall({ call, error })).then(reportNotRun));
    return;
  }

  const baseContext: ToolContext = { agentName, instanceId, runId, callId, signal };
  let context: ToolContext = baseContext;
  if (name === MULTI_TOOL_NAME) {
    // The aigent_multi wrapper is not counted itself: each inner call takes from the shared budget instead.
    context = multiToolContext({ context: baseContext, turn, parentCallId: callId });
  } else if (!isCommentary) {
    totals.toolCalls += 1;
  }
  // executeToolCall promises never to reject; this last-resort guard keeps a broken promise from failing the run or going unhandled.
  const execution = executeToolCall({ registry, call, context, now: () => clock.now() })
    .catch((error: unknown) => rejectToolCall({ call, error: describeThrown(error) }));

  const tool = registry.get(name);
  const parsed = tool == null ? undefined : parseToolArgs(tool.argsSchema, args);
  if (tool == null || parsed == null || !parsed.ok) {
    // Unknown tool or invalid arguments: executeToolCall refuses it without running anything.
    work.executions.push(execution.then(reportNotRun));
    return;
  }
  work.executions.push(execution.then(reportResult));
  const outcome = execution.then(executed => executed.outcome);
  work.activities.push(startToolActivity({ tool, args: parsed.value, callId, outcome, signal: work.activityController.signal, emit }));
}
