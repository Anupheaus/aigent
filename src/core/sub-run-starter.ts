import { costOfUsage } from '../scoring/pricing.js';
import type { Pricing } from '../scoring/report-types.js';
import type { Agent, AgentDefinition } from './agent-types.js';
import type { StartedSubRun } from './delegation-types.js';
import type { TaskInput } from './task-input.js';

/** The runtime's agents a `delegate` sub-run can start on. */
export interface SubRunAgents {
  /** The latest definition given for each agent name. */
  definitions: ReadonlyMap<string, AgentDefinition>;
  /** The latest agent created for each name, with its first model. */
  agentsByName: ReadonlyMap<string, { agent: Agent; model: string }>;
}

/** A sub-run request from the `delegate` tool. */
export interface SubRunRequest {
  agentName: string;
  input: TaskInput;
}

/** Starts sub-runs of the named agents (for the `delegate` tool), each priced at that agent's own model. */
export function createSubRunStarter(params: { agents: SubRunAgents; pricing?: Pricing }): (request: SubRunRequest) => StartedSubRun | undefined {
  const { agents: { definitions, agentsByName }, pricing } = params;
  return ({ agentName, input }) => {
    const entry = agentsByName.get(agentName);
    if (entry == null) return undefined;
    // A delegated tool-call budget may only lower the agent's own limit, never raise it.
    const own = definitions.get(agentName)?.limits?.maxToolCalls;
    const granted = input.limits?.maxToolCalls;
    const limits = granted == null || own == null ? input.limits : { ...input.limits, maxToolCalls: Math.min(own, granted) };
    return { run: entry.agent.task({ ...input, ...(limits == null ? {} : { limits }) }), price: usage => costOfUsage({ model: entry.model, usage, ...(pricing == null ? {} : { pricing }) }) ?? undefined };
  };
}
