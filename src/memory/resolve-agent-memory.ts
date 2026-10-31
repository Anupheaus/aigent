import { createAigentError } from '../core/aigent-error.js';
import { resolveMemoryOptions } from './memory-schema.js';
import type { MemoryOptions, ResolvedMemoryOptions } from './memory-types.js';

export interface ResolveAgentMemoryParams {
  agentName: string;
  /** `AgentDefinition.memory`: replaces the runtime default whole when set. */
  agent?: MemoryOptions | boolean;
  /** `createAigent({ memory })`: the default for agents that do not set their own. */
  runtime?: MemoryOptions | boolean;
  hasStore: boolean;
  captureContent: boolean;
}

/**
 * The agent's memory options, or undefined when memory is off (the default: it is opt-in). Memory lives in the
 * runtime's store, and every entry is content, so it is refused without a store and with `captureContent: false`
 * rather than being kept somewhere the consumer did not choose.
 */
export function resolveAgentMemory(params: ResolveAgentMemoryParams): ResolvedMemoryOptions | undefined {
  const { agentName, agent, runtime, hasStore, captureContent } = params;
  const owner = `Agent '${agentName}'`;
  const resolved = resolveMemoryOptions({ owner, options: agent ?? runtime });
  if (resolved == null) return undefined;
  if (!hasStore) {
    throw createAigentError({ code: 'invalid_definition', message: `${owner} enables memory, which needs createAigent({ store }); give the runtime a store or set memory: false`, details: { agentName } });
  }
  if (!captureContent) {
    throw createAigentError({ code: 'invalid_definition', message: `${owner} enables memory, but createAigent has captureContent: false and every memory is content; turn one of them off`, details: { agentName } });
  }
  return resolved;
}
