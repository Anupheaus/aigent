import type { GateOutcome } from '../approvals/approval-gate.js';
import type { ToolCall } from '../providers/provider-types.js';
import { hashArgs } from '../resume/call-ledger.js';
import type { CallLedger } from '../resume/call-ledger.js';
import { executeToolCall, rejectToolCall } from '../tools/execute-tool-call.js';
import { MULTI_TOOL_NAME } from '../tools/multi-tool.js';
import type { ExecutedToolCall, ExecuteToolCallParams } from '../tools/execute-tool-call.js';
import { parseToolArgs } from '../tools/parse-tool-args.js';
import { describeThrown } from '../tools/tool-error-detail.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import type { ToolContext } from '../tools/tool-types.js';
import { describeError } from './describe-value.js';
import type { CallVerdict } from './run-guardrails.js';
import { shapeWith } from './run-shaping.js';
import type { RunTurnParams } from './run-turn.js';

/** One call as the dispatcher runs it: a top-level call, or an `aigent_multi` inner call. */
export interface DispatchedCall {
  /** The call as its tool sees it (an inner call keeps its own id). */
  call: ToolCall;
  turn: RunTurnParams;
  /** The call's context (signal, idempotency key, dry run). */
  context: ToolContext;
  /** The id the ledger and the approval request use: the call id, or `<parentCallId>:<innerId>` for an inner call. */
  ledgerId: string;
  /** Inner calls: the `aigent_multi` call they belong to. */
  parentCallId?: string;
  /** Bookkeeping tools are not checked by guardrails. */
  isCommentary: boolean;
  /** Whether the call is recorded in the ledger (bookkeeping tools other than `ask_user` are not). */
  isLedgered: boolean;
  /** Takes the call from the run's budget once its guardrails allowed it; false refuses it (inner calls only). */
  reserve?(): boolean;
  /** Called once a runnable call passed its guardrails, budget, approval and ledger entry, just before it runs. */
  onAdmitted?(): void;
  /** A person must approve the call, whatever the rules say (a learned skill's step with side effects). */
  forceApproval?: string;
}

function budgetError(params: { call: ToolCall; parentCallId?: string }): ToolErrorDetail {
  const { call, parentCallId } = params;
  const where = parentCallId == null ? '' : `; inner call '${call.id}' to '${call.name}' was not run`;
  return { category: 'denied', code: 'tool_call_limit', retryable: false, message: `Tool call limit reached${where}` };
}

/**
 * Runs the call, recorded in the ledger first when there is one: the `started` entry is stored before the tool runs,
 * so a resumed run never runs a finished call again. A call whose start cannot be recorded is not run.
 */
async function runLedgered(params: { execute: ExecuteToolCallParams; ledger?: CallLedger; ledgerId: string; parentCallId?: string; turn: RunTurnParams; gate?(): Promise<GateOutcome>; guard?(executed: ExecutedToolCall): Promise<ExecutedToolCall>; onAdmitted?(): void }): Promise<ExecutedToolCall> {
  const { execute, ledger, ledgerId, parentCallId, turn, gate, guard, onAdmitted } = params;
  // The toolResult checks run before the ledger keeps the result, so nothing unguarded is stored or restored later.
  const run = async (): Promise<ExecutedToolCall> => {
    onAdmitted?.();
    const executed = await executeToolCall(execute);
    return guard == null ? executed : guard(executed);
  };
  const { call } = execute;
  // Approval comes first: a refused call never starts, so it is never in the ledger.
  const approval = await gate?.();
  if (approval?.isAllowed === false) return rejectToolCall({ call, error: approval.error });
  if (ledger == null) return run();
  try {
    const { thinkingBlocks } = turn.work.partial;
    await ledger.begin({
      callId: ledgerId, tool: call.name, args: call.args, argsHash: hashArgs(call.args), turn: turn.totals.turns,
      ...(parentCallId == null ? {} : { parentCallId }),
      // The response's thinking so far precedes its tool calls: kept so a round rebuilt from the ledger is still valid.
      ...(parentCallId == null && thinkingBlocks.length > 0 ? { thinkingBlocks: [...thinkingBlocks] } : {}),
    });
  } catch (error) {
    return rejectToolCall({ call, error: { category: 'denied', code: 'ledger_unavailable', retryable: true, message: `The call was not run because its start could not be recorded: ${describeError(error)}` } });
  }
  const executed = await run();
  // The effect happened either way; a lost `done` only means a resume treats the call by its resume policy.
  await ledger.complete(ledgerId, { envelope: executed.envelope, ...(executed.effects == null ? {} : { effects: executed.effects }) }).catch(() => undefined);
  return executed;
}

/**
 * The one path every work call takes, top-level or inside `aigent_multi`: `toolCall` guardrails, the budget, the
 * approval gate, the ledger, the tool (cache, dry run), then `toolResult` guardrails. Never rejects.
 */
export function runDispatchedCall(params: DispatchedCall): Promise<ExecutedToolCall> {
  const { call, turn, context, ledgerId, parentCallId, isCommentary, isLedgered, reserve, onAdmitted, forceApproval } = params;
  const { registry, clock, cache, shaping, guardrails, effects, approve } = turn;
  const tool = registry.get(call.name);
  const parsed = tool == null ? undefined : parseToolArgs(tool.argsSchema, call.args);
  const isRunnable = tool != null && parsed != null && parsed.ok;
  const isDryRun = effects?.dryRun === true;
  const ledger = isLedgered ? turn.ledger : undefined;
  // Guardrails see work calls only (bookkeeping tools change run state, nothing else); a block means the call never runs.
  const isGuarded = guardrails != null && isRunnable && !isCommentary;
  // A wrapper's result (aigent_multi, a learned skill) is checked call by call as its inner calls finish, so it is not checked again as a whole.
  const isWrapping = call.name === MULTI_TOOL_NAME || tool?.composedTools != null;
  const guard = isGuarded && !isWrapping ? guardrails.checkToolResult : undefined;
  const start = (verdict: CallVerdict): Promise<ExecutedToolCall> => {
    if ('error' in verdict) return Promise.resolve(rejectToolCall({ call, error: verdict.error }));
    const checked = verdict.call;
    if (reserve != null && !reserve()) return Promise.resolve(rejectToolCall({ call: checked, error: budgetError({ call: checked, ...(parentCallId == null ? {} : { parentCallId }) }) }));
    // A call that must be approved is refused (fail closed) when there is nobody to ask.
    if (forceApproval != null && approve == null && isRunnable && !(isDryRun && tool.hasSideEffects)) {
      return Promise.resolve(rejectToolCall({ call: checked, error: { category: 'denied', code: 'approval_required', retryable: false, message: `${forceApproval}, so it needs a person's approval, and this run cannot ask for one` } }));
    }
    // The request is keyed by the ledger id, so two inner calls with the same id in different wrappers never collide.
    const gateCall = { ...checked, id: ledgerId };
    return runLedgered({
      // A simulated (or refused) call changes nothing, so there is nothing for a person to approve.
      ...(approve == null || !isRunnable || (isDryRun && tool.hasSideEffects) ? {} : { gate: () => approve({ call: gateCall, tool, context, ...(forceApproval == null ? {} : { force: { reason: forceApproval } }) }) }),
      execute: {
        registry, call: checked, context, now: () => clock.now(),
        // Inner calls wait for approvals and enforce their own timeouts; a wrapper timeout would cut those waits short
        // and tell the model the calls failed while they may still run.
        ...(isWrapping ? { timeoutMs: Number.POSITIVE_INFINITY } : {}),
        ...(cache == null ? {} : { cache }),
        // Inner results reach the model inside their wrapper's result, which is shaped as a whole.
        ...(shaping == null || parentCallId != null ? {} : { shape: shapeWith(shaping) }),
      },
      ledgerId, turn, ...(parentCallId == null ? {} : { parentCallId }), ...(ledger == null ? {} : { ledger }), ...(guard == null ? {} : { guard }),
      // An unknown tool or invalid arguments are refused by executeToolCall: such a call is never admitted.
      ...(onAdmitted == null || !isRunnable ? {} : { onAdmitted }),
    });
  };
  const verdict: CallVerdict | Promise<CallVerdict> = isGuarded ? guardrails.checkToolCall(call) : { call };
  // executeToolCall promises never to reject; this last-resort guard keeps a broken promise from failing the run or going unhandled.
  return (verdict instanceof Promise ? verdict.then(start) : start(verdict))
    .catch((error: unknown) => rejectToolCall({ call, error: describeThrown(error) }));
}
