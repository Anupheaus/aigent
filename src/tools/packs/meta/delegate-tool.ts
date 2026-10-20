import { z } from 'zod';
import type { TaskResult } from '../../../core/agent-types.js';
import { MAX_DELEGATION_DEPTH } from '../../../core/delegation-types.js';
import type { DelegationContext, DelegationSlot, StartedSubRun } from '../../../core/delegation-types.js';
import type { PlannedEffectInput } from '../../../effects/planned-effects.js';
import { defineTool } from '../../define-tool.js';
import { toolFailure } from '../../tool-failure.js';
import type { Tool, ToolContext } from '../../tool-types.js';
import { delegateDescription, envelopeOf } from './delegate-envelope.js';

export const DELEGATE_TOOL_NAME = 'delegate';
/** Default size of the answer handed back, in estimated tokens (4 characters each). */
export const DEFAULT_RETURN_BUDGET_TOKENS = 2_000;
const MAX_RETURN_BUDGET_TOKENS = 50_000;
/** Default longest a sub-run may take before it is stopped (immediately) and its usage rolled up. */
export const DEFAULT_DELEGATE_TIMEOUT_MS = 3_600_000;
/** The tool's own timeout is a little longer, so the sub-run's stop (and usage roll-up) always comes first. */
const TIMEOUT_GRACE_MS = 30_000;
/** Default most sub-runs one run may have in flight at once. */
export const DEFAULT_MAX_CONCURRENT_DELEGATIONS = 4;
/** Default most tool calls reserved for one sub-run from the calling run's `maxToolCalls`. */
export const DEFAULT_MAX_TOOL_CALLS_PER_DELEGATION = 25;
/** Sub-run events passed into the parent's stream: progress and decisions, not the sub-run's text. */
const FORWARDED_EVENTS: ReadonlySet<string> = new Set(['activity', 'tool-call', 'tool-result', 'approval-request', 'approval-decision', 'warning', 'error', 'done']);

/** A delegation target with its own rules. */
export interface DelegateTarget {
  /** The agent's name (created with `ai.agent` in the same runtime). */
  name: string;
  /** Ask a person before each delegation to it: use for agents with broader permissions than the caller. */
  requiresApproval?: boolean;
}

export interface DelegateToolOptions {
  /** Agents this tool may run: names, or targets with their own rules. */
  targets: readonly (string | DelegateTarget)[];
  /** Default `DEFAULT_RETURN_BUDGET_TOKENS`. */
  defaultReturnBudgetTokens?: number;
  /** Default `DEFAULT_MAX_CONCURRENT_DELEGATIONS`. */
  maxConcurrentDelegations?: number;
  /** Default `DEFAULT_MAX_TOOL_CALLS_PER_DELEGATION` (never more than the calling run has left). */
  maxToolCallsPerDelegation?: number;
  /** Default `DEFAULT_DELEGATE_TIMEOUT_MS`. */
  timeoutMs?: number;
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

/** Checks the request against targets, cycles, depth, concurrency and budget, then starts the linked sub-run. */
function startSubRun(params: { args: DelegateArgs; context: ToolContext; options: DelegateToolOptions; names: string[] }): { delegation: DelegationContext; started: StartedSubRun; slot: DelegationSlot } {
  const { args: { agent, task }, context: { delegation, dryRun }, options, names } = params;
  if (delegation == null) refused({ code: 'no_delegation', message: 'delegate only works inside a run of an agent created with ai.agent', suggestion: 'Call it from an agent run' });
  if (!names.includes(agent)) refused({ code: 'agent_not_allowed', message: `Agent '${agent}' is not one this tool may delegate to`, suggestion: `Delegate to one of: ${names.join(', ')}` });
  if (delegation.ancestors.includes(agent)) refused({ code: 'delegation_cycle', message: `Agent '${agent}' is already working on this task further up the chain (${delegation.ancestors.join(' > ')}), so delegating to it would loop`, suggestion: 'Do this part yourself, or delegate to a different agent' });
  if (delegation.depth + 1 > MAX_DELEGATION_DEPTH) refused({ code: 'depth_limit', message: `Delegation is limited to ${MAX_DELEGATION_DEPTH} levels and this run is already at depth ${delegation.depth}`, suggestion: 'Do this part of the task yourself' });
  const maxConcurrent = options.maxConcurrentDelegations ?? DEFAULT_MAX_CONCURRENT_DELEGATIONS;
  const slot = delegation.admit({ maxConcurrent, wantedToolCalls: options.maxToolCallsPerDelegation ?? DEFAULT_MAX_TOOL_CALLS_PER_DELEGATION });
  if ('refused' in slot) {
    if (slot.refused === 'concurrency') refused({ code: 'too_many_delegations', message: `This run already has ${maxConcurrent} delegated tasks in flight`, suggestion: 'Wait for one to finish, or do this part yourself' });
    refused({ code: 'delegation_budget_exhausted', message: 'This run has no tool calls left to give a delegated task (delegated calls count against its maxToolCalls)', suggestion: 'Finish with what you have, or do this part yourself' });
  }
  const input = { task, unattended: delegation.isUnattended, priority: delegation.priority, signal: delegation.runSignal, limits: { maxToolCalls: slot.toolCalls }, ...(dryRun === true ? { dryRun: true } : {}) };
  const started = delegation.start({ agentName: agent, input });
  if (started == null) {
    slot.release();
    refused({ code: 'unknown_agent', message: `No agent named '${agent}' exists in this runtime`, suggestion: `Delegate to one of: ${names.join(', ')}` });
  }
  return { delegation, started, slot };
}

/**
 * Runs the sub-run to its end, forwarding its progress, and adds its usage to the parent's. The sub-run stops with
 * its parent (gracefully or at once, as the parent does), at once when this call is aborted or times out, and at once
 * if following it fails, so it never outlives the call.
 */
async function follow(params: { delegation: DelegationContext; started: StartedSubRun; agent: string; signal: AbortSignal; timeoutMs: number }): Promise<TaskResult> {
  const { delegation, started: { run, price }, agent, signal, timeoutMs } = params;
  let isSettled = false;
  const stopNow = (): void => { if (!isSettled) run.stop({ mode: 'immediate' }); };
  const onStop = (): void => { if (!delegation.runSignal.aborted && !isSettled) run.stop({ mode: 'graceful' }); };
  if (delegation.stopSignal.aborted) onStop();
  else delegation.stopSignal.addEventListener('abort', onStop, { once: true });
  if (signal.aborted) stopNow();
  else signal.addEventListener('abort', stopNow, { once: true });
  const timer = setTimeout(stopNow, timeoutMs);
  try {
    for await (const event of run) if (FORWARDED_EVENTS.has(event.type)) delegation.forward({ agentName: agent, runId: run.runId, event });
    const result = await run;
    isSettled = true;
    const { inputTokens, outputTokens, cachedTokens, turns, toolCalls } = result.usage;
    const costUsd = price(result.usage);
    delegation.addUsage({ inputTokens, outputTokens, cachedTokens, turns, toolCalls, ...(costUsd == null ? {} : { costUsd }) });
    return result;
  } finally {
    clearTimeout(timer);
    stopNow();
    delegation.stopSignal.removeEventListener('abort', onStop);
    signal.removeEventListener('abort', stopNow);
  }
}

/**
 * `delegate`: hands a task to another agent of the same runtime as a linked sub-run (`parent` on its run), with its
 * activity rolled into the caller's and its usage added to `usage.delegated`. Bounded: at most `MAX_DELEGATION_DEPTH`
 * levels, no cycles (an agent already up the chain is refused), `maxConcurrentDelegations` in flight per run, each
 * sub-run's tool calls reserved from (and counted against) the caller's `maxToolCalls`, a timeout, and stops
 * propagated. Targets marked `requiresApproval` need a person's approval. In a dry run the sub-run is a dry run too,
 * and its planned effects are this call's.
 */
export function createDelegateTool(options: DelegateToolOptions): Tool {
  const { defaultReturnBudgetTokens = DEFAULT_RETURN_BUDGET_TOKENS, timeoutMs = DEFAULT_DELEGATE_TIMEOUT_MS } = options;
  const targets = options.targets.map(target => (typeof target === 'string' ? { name: target } : target));
  const names = targets.map(({ name }) => name);
  async function delegate(args: DelegateArgs, context: ToolContext): Promise<{ envelope: Record<string, unknown>; result: TaskResult }> {
    const { delegation, started, slot } = startSubRun({ args, context, options, names });
    try {
      const result = await follow({ delegation, started, agent: args.agent, signal: context.signal, timeoutMs });
      return { envelope: envelopeOf({ agent: args.agent, result, budgetTokens: args.returnBudgetTokens ?? defaultReturnBudgetTokens }), result };
    } finally {
      slot.release();
    }
  }
  const tool = defineTool({
    name: DELEGATE_TOOL_NAME,
    description: delegateDescription(names),
    args: delegateArgs, deterministic: false, cache: false, hasSideEffects: true, timeoutMs: timeoutMs + TIMEOUT_GRACE_MS, contentKind: 'structured-data', risk: 'medium',
    requiresApproval: { when: args => targets.find(({ name }) => name === (args as DelegateArgs).agent)?.requiresApproval === true, reason: 'This agent has permissions the caller does not, so a person approves each delegation to it' },
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
