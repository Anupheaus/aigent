import { z } from 'zod';
import type { TaskResult } from '../../../core/agent-types.js';
import { MAX_DELEGATION_DEPTH } from '../../../core/delegation-types.js';
import type { DelegationContext, StartedSubRun } from '../../../core/delegation-types.js';
import type { PlannedEffectInput } from '../../../effects/planned-effects.js';
import { defineTool } from '../../define-tool.js';
import { toolFailure } from '../../tool-failure.js';
import type { Tool, ToolContext } from '../../tool-types.js';

export const DELEGATE_TOOL_NAME = 'delegate';
/** Default size of the answer handed back, in estimated tokens (4 characters each). */
export const DEFAULT_RETURN_BUDGET_TOKENS = 2_000;
const CHARS_PER_TOKEN = 4;
const MAX_RETURN_BUDGET_TOKENS = 50_000;
/** A sub-run has its own limits (turns, tool calls, timeoutMs); this only stops a runaway wait. */
const DELEGATE_TIMEOUT_MS = 3_600_000;
/** Most sub-run errors passed back in full. */
const MAX_RETURNED_ERRORS = 10;
/** Sub-run events passed into the parent's stream: progress and decisions, not the sub-run's text. */
const FORWARDED_EVENTS: ReadonlySet<string> = new Set(['activity', 'tool-call', 'tool-result', 'approval-request', 'approval-decision', 'warning', 'error', 'done']);

export interface DelegateToolOptions {
  /** Agent names this tool may run (each must be created with `ai.agent` in the same runtime). */
  targets: readonly string[];
  /** Default `DEFAULT_RETURN_BUDGET_TOKENS`. */
  defaultReturnBudgetTokens?: number;
}

const delegateArgs = z.object({
  agent: z.string().min(1).describe('Name of the agent to hand the task to'),
  task: z.string().min(1).describe('The complete task for that agent: it sees only this text, not your conversation'),
  returnBudgetTokens: z.number().int().min(1).max(MAX_RETURN_BUDGET_TOKENS).optional().describe(`Most tokens of its answer to return (default ${DEFAULT_RETURN_BUDGET_TOKENS})`),
}).strict();

type DelegateArgs = z.infer<typeof delegateArgs>;

function refused(params: { code: string; message: string; suggestion: string }): never {
  throw toolFailure({ category: 'denied', ...params, retryable: false });
}

/** Checks the request and starts the sub-run, linked to this call, stopping with its parent. */
function startSubRun(params: { args: DelegateArgs; context: ToolContext; options: DelegateToolOptions }): { delegation: DelegationContext; started: StartedSubRun } {
  const { args: { agent, task }, context: { delegation, dryRun }, options: { targets } } = params;
  if (delegation == null) refused({ code: 'no_delegation', message: 'delegate only works inside a run of an agent created with ai.agent', suggestion: 'Call it from an agent run' });
  if (!targets.includes(agent)) refused({ code: 'agent_not_allowed', message: `Agent '${agent}' is not one this tool may delegate to`, suggestion: `Delegate to one of: ${targets.join(', ')}` });
  if (delegation.depth + 1 > MAX_DELEGATION_DEPTH) refused({ code: 'depth_limit', message: `Delegation is limited to ${MAX_DELEGATION_DEPTH} levels and this run is already at depth ${delegation.depth}`, suggestion: 'Do this part of the task yourself' });
  const started = delegation.start({ agentName: agent, input: { task, unattended: delegation.isUnattended, priority: delegation.priority, signal: delegation.runSignal, ...(dryRun === true ? { dryRun: true } : {}) } });
  if (started == null) refused({ code: 'unknown_agent', message: `No agent named '${agent}' exists in this runtime`, suggestion: `Delegate to one of: ${targets.join(', ')}` });
  return { delegation, started };
}

/** Runs the sub-run to its end, forwarding its progress, and adds its usage to the parent's. */
async function follow(params: { delegation: DelegationContext; started: StartedSubRun; agent: string }): Promise<TaskResult> {
  const { delegation, started: { run, price }, agent } = params;
  const onStop = (): void => { if (!delegation.runSignal.aborted) run.stop({ mode: 'graceful' }); };
  if (delegation.stopSignal.aborted) onStop();
  else delegation.stopSignal.addEventListener('abort', onStop, { once: true });
  try {
    for await (const event of run) if (FORWARDED_EVENTS.has(event.type)) delegation.forward({ agentName: agent, runId: run.runId, event });
    const result = await run;
    const { inputTokens, outputTokens, cachedTokens, turns, toolCalls } = result.usage;
    const costUsd = price(result.usage);
    delegation.addUsage({ inputTokens, outputTokens, cachedTokens, turns, toolCalls, ...(costUsd == null ? {} : { costUsd }) });
    return result;
  } finally {
    delegation.stopSignal.removeEventListener('abort', onStop);
  }
}

/** What the model gets back: status, the answer within its budget (with where to find the rest), usage and errors. */
function envelopeOf(params: { agent: string; result: TaskResult; budgetTokens: number }): Record<string, unknown> {
  const { agent, result: { runId, status, answer, usage, errors, failure }, budgetTokens } = params;
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  const isCut = answer.length > budgetChars;
  const shown = isCut ? `${answer.slice(0, budgetChars)}… [answer cut at ${budgetTokens} tokens; the full answer is in run ${runId}]` : answer;
  const { inputTokens, outputTokens, cachedTokens, turns, toolCalls, durationMs } = usage;
  return {
    agent, runId, status, answer: shown, truncated: isCut, ...(isCut ? { fullAnswer: { runId, chars: answer.length } } : {}),
    usage: { inputTokens, outputTokens, cachedTokens, turns, toolCalls, durationMs },
    errors: errors.slice(0, MAX_RETURNED_ERRORS), ...(errors.length > MAX_RETURNED_ERRORS ? { moreErrors: errors.length - MAX_RETURNED_ERRORS } : {}),
    ...(failure == null ? {} : { failure }),
  };
}

/**
 * `delegate`: hands a task to another agent of the same runtime as a linked sub-run (`parent` on its run), with its
 * activity rolled into the caller's, its usage added to `usage.delegated`, at most `MAX_DELEGATION_DEPTH` levels, and
 * stops propagated. In a dry run the sub-run is a dry run too, and its planned effects are this call's.
 */
export function createDelegateTool(options: DelegateToolOptions): Tool {
  const { defaultReturnBudgetTokens = DEFAULT_RETURN_BUDGET_TOKENS } = options;
  async function delegate(args: DelegateArgs, context: ToolContext): Promise<{ envelope: Record<string, unknown>; result: TaskResult }> {
    const { delegation, started } = startSubRun({ args, context, options });
    const result = await follow({ delegation, started, agent: args.agent });
    return { envelope: envelopeOf({ agent: args.agent, result, budgetTokens: args.returnBudgetTokens ?? defaultReturnBudgetTokens }), result };
  }
  const tool = defineTool({
    name: DELEGATE_TOOL_NAME,
    description: `Hand a self-contained task to another agent (${options.targets.join(', ')}) and get back its status and answer. It sees only the task text you give it.`,
    args: delegateArgs, deterministic: false, cache: false, hasSideEffects: true, timeoutMs: DELEGATE_TIMEOUT_MS, contentKind: 'structured-data', risk: 'medium',
    describeActivity: ({ agent }, outcome) => outcome.then(({ success, reason }) => ({ title: `Delegated to ${agent}`, ...(success ? {} : { detail: reason }) }), () => ({ title: `Delegating to ${agent}` })),
    run: async (args, context) => (await delegate(args, context)).envelope,
    dryRun: async (args, context) => {
      const { envelope, result } = await delegate(args, context);
      const effects: PlannedEffectInput[] = (result.plannedEffects ?? []).map(({ tool: _tool, callId: _callId, summary, ...effect }) => ({ ...effect, summary: `${args.agent}: ${summary}` }));
      return { result: envelope, effects };
    },
  });
  return { ...tool, startsSubRuns: true, summarise: result => {
    const { status, agent } = result as { status?: string; agent?: string };
    return status === 'completed' ? { success: true, reason: `${agent} completed` } : { success: false, reason: `${agent} ended ${status}` };
  } };
}
