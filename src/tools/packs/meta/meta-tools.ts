import type { Tool } from '../../tool-types.js';
import { createDelegateTool } from './delegate-tool.js';

/** `metaTools(options)`. */
export interface MetaToolsOptions {
  /** Agent names `delegate` may hand tasks to; none (the default) means the tool is not registered. */
  delegateTargets?: string[];
  /** Default size of a delegated answer handed back, in tokens. */
  defaultReturnBudgetTokens?: number;
}

/**
 * The agent/meta pack: `delegate` (when it has targets). The other built-ins (`aigent_multi`, `aigent_feedback`,
 * `plan_complete`, `todo`, `ask_user`, `result_original`) stay registered by the core.
 */
export function metaTools(options: MetaToolsOptions = {}): Tool[] {
  const { delegateTargets = [], defaultReturnBudgetTokens } = options;
  if (delegateTargets.length === 0) return [];
  return [createDelegateTool({ targets: [...delegateTargets], ...(defaultReturnBudgetTokens == null ? {} : { defaultReturnBudgetTokens }) })];
}
