import type { Tool } from '../../tool-types.js';
import { createDelegateTool } from './delegate-tool.js';
import type { DelegateTarget } from './delegate-tool.js';

/** `metaTools(options)`. */
export interface MetaToolsOptions {
  /**
   * Agents `delegate` may hand tasks to: names, or `{ name, requiresApproval }` for agents with broader permissions
   * than the caller. None (the default) means the tool is not registered.
   */
  delegateTargets?: (string | DelegateTarget)[];
  /** Default size of a delegated answer handed back, in tokens. */
  defaultReturnBudgetTokens?: number;
  /** Most delegated sub-runs one run may have in flight at once (default 4). */
  maxConcurrentDelegations?: number;
  /** Most tool calls reserved for one sub-run from the caller's `maxToolCalls` (default 25). */
  maxToolCallsPerDelegation?: number;
  /** Longest a sub-run may take before it is stopped (default 1 hour). */
  delegateTimeoutMs?: number;
}

/**
 * The agent/meta pack: `delegate` (when it has targets). The other built-ins (`aigent_multi`, `aigent_feedback`,
 * `plan_complete`, `todo`, `ask_user`, `result_original`) stay registered by the core.
 */
export function metaTools(options: MetaToolsOptions = {}): Tool[] {
  const { delegateTargets = [], defaultReturnBudgetTokens, maxConcurrentDelegations, maxToolCallsPerDelegation, delegateTimeoutMs } = options;
  if (delegateTargets.length === 0) return [];
  return [createDelegateTool({
    targets: [...delegateTargets],
    ...(defaultReturnBudgetTokens == null ? {} : { defaultReturnBudgetTokens }),
    ...(maxConcurrentDelegations == null ? {} : { maxConcurrentDelegations }),
    ...(maxToolCallsPerDelegation == null ? {} : { maxToolCallsPerDelegation }),
    ...(delegateTimeoutMs == null ? {} : { timeoutMs: delegateTimeoutMs }),
  })];
}
