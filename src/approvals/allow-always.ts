import type { AllowAlwaysScope, ApprovalRule } from './approval-types.js';

/** Who an `allow_always` rule belongs to. */
export interface AllowAlwaysOwner {
  agentName: string;
  instanceId: string;
}

/**
 * The runtime's `allow_always` rules, kept per agent instance unless a decision widened them to every instance of the
 * agent (`across: 'agent'`) or every agent of the runtime (`across: 'runtime'`). In memory only: lost on restart.
 */
export interface AllowAlwaysRules {
  add(params: { rule: ApprovalRule; across: AllowAlwaysScope; owner: AllowAlwaysOwner }): void;
  /** The rules that apply to calls of this agent instance. */
  rulesFor(owner: AllowAlwaysOwner): ApprovalRule[];
}

export function createAllowAlwaysRules(): AllowAlwaysRules {
  const runtime: ApprovalRule[] = [];
  const byAgent = new Map<string, ApprovalRule[]>();
  const byInstance = new Map<string, ApprovalRule[]>();
  const listIn = (map: Map<string, ApprovalRule[]>, key: string): ApprovalRule[] => {
    const existing = map.get(key);
    if (existing != null) return existing;
    const created: ApprovalRule[] = [];
    map.set(key, created);
    return created;
  };
  return {
    add: ({ rule, across, owner: { agentName, instanceId } }) => {
      if (across === 'runtime') runtime.push(rule);
      else if (across === 'agent') listIn(byAgent, agentName).push(rule);
      else listIn(byInstance, instanceId).push(rule);
    },
    rulesFor: ({ agentName, instanceId }) => [...byInstance.get(instanceId) ?? [], ...byAgent.get(agentName) ?? [], ...runtime],
  };
}
