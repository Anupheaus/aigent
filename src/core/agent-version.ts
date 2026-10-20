import { createHash } from 'node:crypto';
import type { Tool } from '../tools/tool-types.js';
import { canonicalJson } from './canonical-json.js';
import type { ModelSettings } from './model-settings.js';
import type { TaskLimits } from './task-input.js';

/** The tool fields that change how an agent behaves; code (`run`, renderers) is not hashable and is left out. */
export type AgentVersionTool = Pick<Tool, 'name' | 'description' | 'jsonSchema' | 'strict' | 'deterministic' | 'cache' | 'cacheTtlMs' | 'hasSideEffects' | 'timeoutMs' | 'maxResultTokens'>;

/** Everything behaviour-relevant about an agent. Deliberately excludes `name` and `instanceId`. */
export interface AgentVersionInput {
  libraryVersion: string;
  /** `provider:model`. */
  model: string;
  persona?: string;
  skillset?: string;
  context?: string;
  /** The agent's effective settings (agent > runtime > provider). */
  modelSettings?: ModelSettings;
  limits?: TaskLimits;
  /** The human version label from the definition. */
  version?: string;
  tools: AgentVersionTool[];
}

const HASH_ALGORITHM = 'sha256';

function versionTool(tool: AgentVersionTool): AgentVersionTool {
  const { name, description, jsonSchema, strict, deterministic, cache, cacheTtlMs, hasSideEffects, timeoutMs, maxResultTokens } = tool;
  return { name, description, jsonSchema, strict, deterministic, cache, cacheTtlMs, hasSideEffects, timeoutMs, maxResultTokens };
}

/** Lowercase hex sha-256 of the canonical JSON of the agent's behaviour-relevant fields, with tools sorted by name. */
export function computeAgentVersion(input: AgentVersionInput): string {
  const { libraryVersion, model, persona, skillset, context, modelSettings, limits, version, tools } = input;
  const sortedTools = tools.map(versionTool).sort((left, right) => left.name.localeCompare(right.name));
  const hashed = { libraryVersion, model, persona, skillset, context, modelSettings, limits, version, tools: sortedTools };
  return createHash(HASH_ALGORITHM).update(canonicalJson(hashed)).digest('hex');
}
