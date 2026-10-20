import type { ToolActivityView, ToolContext } from '../tools/tool-types.js';

/** How risky a tool's effect is, shown with its approval request. */
export type ApprovalRisk = 'low' | 'medium' | 'high';

/** A tool's approval requirement with its reason (and when it applies). */
export interface ApprovalPolicy {
  /** When the call needs approval (default: always). */
  when?(args: unknown, context: ToolContext): boolean;
  /** Shown with the request: why this call needs a person's approval. */
  reason?: string;
}

/** `defineTool({ requiresApproval })`: always, by a predicate over the arguments, or a policy. */
export type RequiresApproval = boolean | ((args: unknown, context: ToolContext) => boolean) | ApprovalPolicy;

/** A pre-granted (or pre-refused) rule: a tool, optionally narrowed to arguments. */
export interface ApprovalRule {
  /** The tool's name, or `*` for any tool. */
  tool: string;
  /** Top-level arguments that must be exactly equal. */
  argsMatch?: Record<string, string | number | boolean>;
  /** Further test of the arguments. */
  when?(args: unknown): boolean;
}

/** `createAigent({ approvals })`: deny rules beat allow rules. */
export interface ApprovalOptions {
  allow?: ApprovalRule[];
  deny?: ApprovalRule[];
}

export type ApprovalDecisionKind = 'allow_once' | 'allow_always' | 'deny';

/** Who an `allow_always` rule applies to: this agent instance, every instance of its agent, or every agent of the runtime. */
export type AllowAlwaysScope = 'instance' | 'agent' | 'runtime';

/** `allow_always`: what the new rule covers. By default: this tool with exactly these arguments, for this agent instance. */
export interface ApprovalDecisionScope {
  /** Must be the call's own tool (a rule for another tool, or `*`, is refused with `invalid_input`). */
  tool?: string;
  /** Top-level arguments that must be equal, instead of all of them. */
  argsMatch?: Record<string, string | number | boolean>;
  /** Any arguments of this tool. */
  anyArgs?: boolean;
  /** Default `instance`. Rules are kept in memory only: a restart forgets them. */
  across?: AllowAlwaysScope;
}

/** `agent.approve(requestId, decision)`. */
export interface ApprovalDecision {
  decision: ApprovalDecisionKind;
  /** `allow_always`: what the new rule covers (default: this tool, these exact arguments, this agent instance). */
  scope?: ApprovalDecisionScope;
  note?: string;
}

/** The `approval-request` event: everything a UI needs to ask. */
export interface ApprovalRequest {
  requestId: string;
  callId: string;
  tool: string;
  /** The arguments, summarised (at most 120 characters of canonical JSON). */
  argsSummary: string;
  risk?: ApprovalRisk;
  reason?: string;
  activity: ToolActivityView;
}

/** Who decided: a pre-granted rule, the user (`agent.approve`), or the run's policy (unattended, stopped). */
export type ApprovalDecider = 'rule' | 'user' | 'policy';

/** One decision as the audit trail (collection `approvals`) stores it. */
export interface ApprovalAuditRecord {
  requestId: string;
  runId: string;
  agentName: string;
  instanceId: string;
  tool: string;
  argsHash: string;
  decision: ApprovalDecisionKind | 'denied_unattended' | 'aborted';
  by: ApprovalDecider;
  /** This decision's place among the request's decisions (1 first); the record's key is `<requestId>:<sequence>`. */
  sequence: number;
  /** Epoch ms; also `recordedAt` so `ai.purge` can remove old entries. */
  at: number;
  recordedAt: number;
  note?: string;
}
