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

/** `agent.approve(requestId, decision)`. */
export interface ApprovalDecision {
  decision: ApprovalDecisionKind;
  /** `allow_always`: what the new rule covers (default: this tool, any arguments). */
  scope?: { tool?: string; argsMatch?: Record<string, string | number | boolean> };
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
  /** Epoch ms; also `recordedAt` so `ai.purge` can remove old entries. */
  at: number;
  recordedAt: number;
  note?: string;
}
