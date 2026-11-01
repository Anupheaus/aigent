import { createHash } from 'node:crypto';
import type { CompactionPolicy } from '../context/compaction-policy.js';
import type { ShapersSetting } from '../shapers/shaper-types.js';
import type { ResolvedMemoryOptions } from '../memory/memory-types.js';
import type { Tool } from '../tools/tool-types.js';
import { DEFAULT_LIMITS } from './agent-types.js';
import { canonicalJson } from './canonical-json.js';
import type { ModelSettings } from './model-settings.js';
import { DEFAULT_RESILIENCE_POLICY } from './resilience-policy.js';
import type { ResiliencePolicy } from './resilience-policy.js';
import type { TaskLimits } from './task-input.js';
import type { ModelRoutes } from '../routing/routing-types.js';

/** The tool fields that change how an agent behaves; code (`run`, renderers) is not hashable and is left out. */
export type AgentVersionTool = Pick<Tool, 'name' | 'description' | 'jsonSchema' | 'strict' | 'deterministic' | 'cache' | 'cacheTtlMs' | 'hasSideEffects' | 'timeoutMs' | 'maxResultTokens' | 'version' | 'contentKind' | 'fidelity' | 'acceptsAliases' | 'cacheNamespace' | 'sharedCache' | 'compactable' | 'compressible' | 'promptAddendum'>;

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
  /** The effective compaction policy, only when the definition sets one (so versions without it are unchanged). */
  compaction?: CompactionPolicy;
  /** `compactionModel`, when set. */
  compactionModel?: string;
  /** The resolved compression settings (compressor by id and version), when the agent compresses. */
  compression?: Record<string, unknown>;
  /** The resolved memory options, only when memory is on (it adds a prompt addendum and a field to every tool). */
  memory?: ResolvedMemoryOptions;
  /** The agent's model routes, when `model` is a route set (`model` is then its `default`). */
  routes?: ModelRoutes;
}

const HASH_ALGORITHM = 'sha256';

function versionTool(tool: AgentVersionTool): AgentVersionTool {
  const { name, description, jsonSchema, strict, deterministic, cache, cacheTtlMs, hasSideEffects, timeoutMs, maxResultTokens, version, contentKind, fidelity, acceptsAliases, cacheNamespace, sharedCache, compactable, compressible, promptAddendum } = tool;
  // The newer fields are undefined unless set, and undefined fields are not hashed, so earlier versions are unchanged.
  return { name, description, jsonSchema, strict, deterministic, cache, cacheTtlMs, hasSideEffects, timeoutMs, maxResultTokens, version, contentKind, fidelity, acceptsAliases, cacheNamespace, sharedCache, compactable, compressible, promptAddendum };
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
  const { libraryVersion, model, persona, skillset, context, modelSettings, limits, version, tools, fallbacks = [], resilience, enableFeedback = false, shapers, todo = true, compaction, compactionModel, compression, memory, routes } = input;
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
    ...(compaction == null ? {} : { compaction }),
    ...(compactionModel == null ? {} : { compactionModel }),
    ...(compression == null ? {} : { compression }),
    // Only when on, so the versions of agents without memory are unchanged.
    ...(memory == null ? {} : { memory }),
    // Only for routed agents, so the versions of single-model agents are unchanged.
    ...(routes == null ? {} : { routes }),
    tools: sortedTools,
  };
  return createHash(HASH_ALGORITHM).update(canonicalJson(hashed)).digest('hex');
}

/** Learned parts a run applies on top of its agent, each identified by id and content. */
export interface LearnedVersionInput {
  agentVersion: string;
  /** Strategy variants the run applies. */
  variants?: { id: string; changes: unknown }[];
  /** Skills the run offers or hints at (with their version, status and what they contain: a version number is only a label). */
  skills?: { id: string; version: number; status: string; content: unknown }[];
}

/**
 * The run's effective agent version: the agent's own when nothing learned applies (so removing everything learned
 * restores it exactly), else the hash of the agent's version with the learned parts sorted by id.
 */
export function withLearnedVersion(input: LearnedVersionInput): string {
  const { agentVersion, variants = [], skills = [] } = input;
  if (variants.length === 0 && skills.length === 0) return agentVersion;
  const byId = <T extends { id: string }>(left: T, right: T): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const hashed = { agentVersion, variants: [...variants].sort(byId), skills: [...skills].sort(byId) };
  return createHash(HASH_ALGORITHM).update(canonicalJson(hashed)).digest('hex');
}
