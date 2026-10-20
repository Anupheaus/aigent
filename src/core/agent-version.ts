import { createHash } from 'node:crypto';
import type { ShapersSetting } from '../shapers/shaper-types.js';
import type { Tool } from '../tools/tool-types.js';
import { DEFAULT_LIMITS } from './agent-types.js';
import { canonicalJson } from './canonical-json.js';
import type { ModelSettings } from './model-settings.js';
import { DEFAULT_RESILIENCE_POLICY } from './resilience-policy.js';
import type { ResiliencePolicy } from './resilience-policy.js';
import type { TaskLimits } from './task-input.js';

/** The tool fields that change how an agent behaves; code (`run`, renderers) is not hashable and is left out. */
export type AgentVersionTool = Pick<Tool, 'name' | 'description' | 'jsonSchema' | 'strict' | 'deterministic' | 'cache' | 'cacheTtlMs' | 'hasSideEffects' | 'timeoutMs' | 'maxResultTokens' | 'version' | 'contentKind' | 'fidelity' | 'acceptsAliases' | 'cacheNamespace' | 'sharedCache' | 'compactable'>;

/** A fallback model and the settings it would be sent. */
export interface AgentVersionFallback {
  /** `provider:model`. */
  model: string;
  /** Its effective settings (agent > runtime > its provider's layer), which can differ from the primary's. */
  modelSettings?: ModelSettings;
}

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
  /** Fallback models in order. */
  fallbacks?: AgentVersionFallback[];
  /** The policy overrides from the definition; defaults are filled in before hashing. */
  resilience?: Partial<ResiliencePolicy>;
  /** The resolved flag: it changes the prompt and the tool list. Absent means off. */
  enableFeedback?: boolean;
  /** The agent's `shapers`; absent means the default (every built-in shaper). */
  shapers?: ShapersSetting;
  /** False when the built-in `todo` tool is turned off; absent means on. */
  todo?: boolean;
}

const HASH_ALGORITHM = 'sha256';

function versionTool(tool: AgentVersionTool): AgentVersionTool {
  const { name, description, jsonSchema, strict, deterministic, cache, cacheTtlMs, hasSideEffects, timeoutMs, maxResultTokens, version, contentKind, fidelity, acceptsAliases, cacheNamespace, sharedCache, compactable } = tool;
  // The newer fields are undefined unless set, and undefined fields are not hashed, so earlier versions are unchanged.
  return { name, description, jsonSchema, strict, deterministic, cache, cacheTtlMs, hasSideEffects, timeoutMs, maxResultTokens, version, contentKind, fidelity, acceptsAliases, cacheNamespace, sharedCache, compactable };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Drops `undefined`, empty strings, empty arrays and empty objects, recursively: they configure nothing, so
 * `{ providerOptions: { p: {} } }` hashes like `{}`. Not applied to tool schemas, where an empty object is meaningful.
 */
function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(pruneEmpty).filter(item => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).map(([key, field]) => [key, pruneEmpty(field)] as const).filter(([, field]) => field !== undefined);
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
  }
  return value === '' ? undefined : value;
}

/** The policy with defaults filled in, so `{}`, the defaults spelt out and no policy at all hash alike. */
function effectivePolicy(resilience: Partial<ResiliencePolicy> | undefined): ResiliencePolicy {
  const defined = Object.fromEntries(Object.entries(resilience ?? {}).filter(([, value]) => value !== undefined));
  return { ...DEFAULT_RESILIENCE_POLICY, ...defined };
}

/** Limits with the library defaults filled in. */
function effectiveLimits(limits: TaskLimits | undefined): TaskLimits {
  const { maxTurns = DEFAULT_LIMITS.maxTurns, maxToolCalls = DEFAULT_LIMITS.maxToolCalls, timeoutMs } = limits ?? {};
  return { maxTurns, maxToolCalls, timeoutMs };
}

/**
 * Lowercase hex sha-256 of the canonical JSON of the agent's behaviour-relevant fields, with tools sorted by name.
 * Empty and default-valued fields are normalised first, so only a change in behaviour changes the hash.
 */
export function computeAgentVersion(input: AgentVersionInput): string {
  const { libraryVersion, model, persona, skillset, context, modelSettings, limits, version, tools, fallbacks = [], resilience, enableFeedback = false, shapers, todo = true } = input;
  const sortedTools = tools.map(versionTool).sort((left, right) => left.name.localeCompare(right.name));
  const hashed = {
    libraryVersion,
    model,
    ...(pruneEmpty({ persona, skillset, context, version, modelSettings, fallbacks }) as Record<string, unknown> | undefined),
    limits: effectiveLimits(limits),
    resilience: effectivePolicy(resilience),
    enableFeedback,
    ...(shapers == null ? {} : { shapers }),
    // Only the non-default value is hashed, so versions computed before the todo tool existed are unchanged.
    ...(todo ? {} : { todo }),
    tools: sortedTools,
  };
  return createHash(HASH_ALGORITHM).update(canonicalJson(hashed)).digest('hex');
}
