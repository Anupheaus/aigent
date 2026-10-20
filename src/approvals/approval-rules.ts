import { createAigentError } from '../core/aigent-error.js';
import { hashArgs } from '../resume/call-ledger.js';
import type { ToolContext } from '../tools/tool-types.js';
import type { ApprovalDecision, ApprovalOptions, ApprovalRule, RequiresApproval } from './approval-types.js';

/** Matches any tool in a rule. */
const ANY_TOOL = '*';

/** What the rules say about a call: allowed, refused, or a person must decide. */
export type RuleVerdict = 'allow' | 'deny' | 'ask';

/** Whether the tool's declaration asks for approval of these arguments. */
export function needsApproval(params: { requiresApproval: RequiresApproval | undefined; args: unknown; context: ToolContext }): boolean {
  const { requiresApproval, args, context } = params;
  if (requiresApproval == null || typeof requiresApproval === 'boolean') return requiresApproval === true;
  if (typeof requiresApproval === 'function') return requiresApproval(args, context);
  return requiresApproval.when?.(args, context) ?? true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matches(params: { rule: ApprovalRule; tool: string; args: unknown }): boolean {
  const { rule: { tool: ruleTool, argsMatch, when }, tool, args } = params;
  if (ruleTool !== ANY_TOOL && ruleTool !== tool) return false;
  if (argsMatch != null && !(isRecord(args) && Object.entries(argsMatch).every(([key, value]) => args[key] === value))) return false;
  return when?.(args) ?? true;
}

/** Deny rules first (a matching deny wins over any allow), then allow rules; otherwise a person decides. */
export function decideByRules(params: { tool: string; args: unknown; rules: ApprovalOptions }): RuleVerdict {
  const { tool, args, rules: { allow = [], deny = [] } } = params;
  if (deny.some(rule => matches({ rule, tool, args }))) return 'deny';
  if (allow.some(rule => matches({ rule, tool, args }))) return 'allow';
  return 'ask';
}

/**
 * The rule an `allow_always` decision adds: the call's tool with exactly its arguments, unless the scope narrows them
 * to `argsMatch` or allows any (`anyArgs`). Throws `invalid_input` for a scope that names another tool.
 */
export function ruleFromScope(params: { tool: string; args: unknown; scope?: ApprovalDecision['scope'] }): ApprovalRule {
  const { tool, args, scope } = params;
  if (scope?.tool != null && scope.tool !== tool) {
    throw createAigentError({ code: 'invalid_input', message: `An allow_always decision for a '${tool}' call cannot cover tool '${scope.tool}'; it only covers the tool that asked`, details: { tool, scopeTool: scope.tool } });
  }
  if (scope?.anyArgs === true) return { tool };
  if (scope?.argsMatch != null) return { tool, argsMatch: scope.argsMatch };
  const argsHash = hashArgs(args);
  return { tool, when: callArgs => hashArgs(callArgs) === argsHash };
}
