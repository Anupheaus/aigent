import { z } from 'zod';
import { hashSchema } from '../cache/cache-key.js';
import { CONTENT_KINDS, FIDELITIES } from '../shapers/shaper-types.js';
import type { ContentKind, Fidelity } from '../shapers/shaper-types.js';
import { createAigentError } from '../core/aigent-error.js';
import { toLooseJsonSchema } from './loose-schema.js';
import { toStrictJsonSchema } from './strict-schema.js';
import type { ApprovalRisk, RequiresApproval } from '../approvals/approval-types.js';
import { validateApprovalFields, validateEffectFields, validateResumeFields } from './tool-policies.js';
import type { DryRunOutput } from '../effects/planned-effects.js';
import type { UndoContext, UndoDescriptor, UndoOutcome } from '../effects/undo-types.js';
import type { DescribeActivity, Tool, ToolContext, ToolResumePolicy, ToolVerifyResult } from './tool-types.js';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFINITION_ID_PREFIX = 'tooldef-';

/** Counts definitions made in this process, for `Tool.definitionId`. */
let definitionCount = 0;

export interface ToolBaseInput {
  name: string;
  description: string;
  /** Required: same name + args always give the same result. */
  deterministic: boolean;
  /** Required: whether results may be cached. */
  cache: boolean;
  /** Required when `cache` is true and `deterministic` is false. */
  cacheTtlMs?: number;
  /** Contract version label; bump it to invalidate cached results. */
  version?: string;
  /**
   * Deterministic cached tools only: entries are shared with every tool using the same namespace (and name, version,
   * schema and description), in any agent or runtime on the same store. Default: the requesting agent's own namespace.
   */
  cacheNamespace?: string;
  /** Deterministic cached tools only: true shares entries with every agent in the `global` namespace. Default false. */
  sharedCache?: boolean;
  /** What the result contains (`file-content`, `web-page`, `command-output`...). */
  contentKind?: ContentKind;
  /** Default `verbatim`. `lossy-ok` (which needs `contentKind`) lets shapers for that kind shorten what the model sees. */
  fidelity?: Fidelity;
  hasSideEffects?: boolean;
  /**
   * Default false. True lets the model write an alias from a shaped result (`F1`) as a whole string argument, expanded
   * to its text before validation. Only for arguments that are references (paths, ids), never literal values.
   */
  acceptsAliases?: boolean;
  timeoutMs?: number;
  maxResultTokens?: number;
  /** Default true. False keeps this tool's results out of compaction (never stubbed or summarised). */
  compactable?: boolean;
  /**
   * Default false. True lets a configured compressor shorten this tool's prose results when they are committed to
   * history; `'allow-code'` also allows results that look like code, diffs or JSON.
   */
  compressible?: boolean | 'allow-code';
  /**
   * Default true: the argument schema must fit the strict subset (every object `.strict()`, optionals sent as null) and
   * providers send the tool with strict decoding. `false` is an explicit opt-out for tools whose arguments a strict schema
   * cannot describe; the built-in `aigent_multi` is the only library tool that uses it. Arguments are still validated by zod.
   */
  strictSchema?: boolean;
  /** After a crash: `rerun`, `verify`, `ask` or `skip` a call that had started (default `rerun`, or `ask` with side effects). */
  resume?: ToolResumePolicy;
  /** A person must approve each call first (see `agent.approve`): always, by a predicate, or a policy with its reason. */
  requiresApproval?: RequiresApproval;
  /** Shown with approval requests. */
  risk?: ApprovalRisk;
  /** Text added once to the system prompt of agents with this tool (identical addenda appear once). */
  promptAddendum?: string;
}

export interface ToolInput<TSchema extends z.ZodType> extends ToolBaseInput {
  args: TSchema;
  /** Cached tools only: normalises the arguments into the cache key (default: the arguments). */
  cacheKey?(args: z.infer<TSchema>): unknown;
  /** Cached tools only: a token that changes when the data behind a result changes (e.g. mtime + size). */
  validity?(args: z.infer<TSchema>, context: ToolContext): Promise<string>;
  describeActivity: DescribeActivity<z.infer<TSchema>>;
  run(args: z.infer<TSchema>, context: ToolContext): Promise<unknown>;
  /** Required with `resume: 'verify'`: whether an interrupted call's effect already happened. */
  verify?(args: z.infer<TSchema>, context: ToolContext): Promise<ToolVerifyResult>;
  /** Tools with side effects: what the call would do, without doing it (dry runs refuse mutating tools without it). */
  dryRun?(args: z.infer<TSchema>, context: ToolContext): Promise<DryRunOutput>;
  /** Tools with side effects: after a successful call, the plain-JSON data that reverses it (with `applyUndo`). */
  undo?(args: z.infer<TSchema>, result: unknown, context: ToolContext): Promise<UndoDescriptor | undefined>;
  /** Reverses one recorded call from its descriptor (`agent.undo`). */
  applyUndo?(descriptor: UndoDescriptor, context: UndoContext): Promise<UndoOutcome>;
}

/** The cache fields every tool input may carry, checked without their argument types. */
interface CacheFieldsInput {
  cacheKey?: unknown;
  validity?: unknown;
}

export function invalid(toolName: string, message: string): never {
  throw createAigentError({ code: 'invalid_definition', message: `Tool '${toolName}': ${message}`, details: { tool: toolName } });
}

function validateCacheFields(input: ToolBaseInput & CacheFieldsInput): void {
  const { name, cache, deterministic, version, cacheKey, validity, cacheNamespace, sharedCache } = input;
  if (version !== undefined && (typeof version !== 'string' || version === '')) invalid(name, `version must be a non-empty string, got ${JSON.stringify(version)}`);
  if (cacheKey !== undefined && typeof cacheKey !== 'function') invalid(name, 'cacheKey must be a function of the arguments');
  if (validity !== undefined && typeof validity !== 'function') invalid(name, 'validity must be a function returning a promise of a token');
  if (!cache && (cacheKey !== undefined || validity !== undefined)) invalid(name, 'cacheKey and validity only apply to cached tools (cache: true)');
  if (cacheNamespace !== undefined && (typeof cacheNamespace !== 'string' || cacheNamespace === '')) invalid(name, `cacheNamespace must be a non-empty string, got ${JSON.stringify(cacheNamespace)}`);
  if (sharedCache !== undefined && typeof sharedCache !== 'boolean') invalid(name, `sharedCache must be a boolean, got ${String(sharedCache)}`);
  if ((cacheNamespace !== undefined || sharedCache !== undefined) && !(cache && deterministic)) {
    invalid(name, 'cacheNamespace and sharedCache only apply to deterministic cached tools (deterministic: true, cache: true); other cached results stay private to their instance');
  }
}

function validateShapingFields(input: ToolBaseInput): void {
  const { name, contentKind, fidelity } = input;
  if (contentKind !== undefined && !(CONTENT_KINDS as readonly unknown[]).includes(contentKind)) invalid(name, `contentKind must be one of ${CONTENT_KINDS.join(', ')}, got ${String(contentKind)}`);
  if (fidelity !== undefined && !(FIDELITIES as readonly unknown[]).includes(fidelity)) invalid(name, `fidelity must be one of ${FIDELITIES.join(', ')}, got ${String(fidelity)}`);
  if (fidelity === 'lossy-ok' && contentKind === undefined) invalid(name, "fidelity 'lossy-ok' needs a contentKind, so only shapers declared for that kind can run");
}

function validateBase(input: ToolBaseInput & CacheFieldsInput & { describeActivity: unknown; dryRun?: unknown; undo?: unknown; applyUndo?: unknown }): void {
  const { name, deterministic, cache, cacheTtlMs, hasSideEffects, acceptsAliases, timeoutMs, describeActivity } = input;
  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) invalid(String(name), `name must match ${TOOL_NAME_PATTERN} (lowercase snake_case), got '${String(name)}'`);
  if (typeof deterministic !== 'boolean') invalid(name, 'deterministic must be declared explicitly (true or false)');
  if (typeof cache !== 'boolean') invalid(name, 'cache must be declared explicitly (true or false)');
  if (typeof describeActivity !== 'function') invalid(name, 'describeActivity is required so the UI can render each call');
  if (hasSideEffects === true && (cache || deterministic)) invalid(name, 'a tool with side effects cannot be cached or deterministic');
  if (cache && !deterministic && (cacheTtlMs == null || cacheTtlMs <= 0)) invalid(name, 'a cached non-deterministic tool needs a positive cacheTtlMs');
  if (acceptsAliases !== undefined && typeof acceptsAliases !== 'boolean') invalid(name, `acceptsAliases must be a boolean, got ${String(acceptsAliases)}`);
  if (timeoutMs !== undefined && !isPositiveInteger(timeoutMs)) invalid(name, `timeoutMs must be a positive integer number of milliseconds, got ${String(timeoutMs)}`);
  validateContextFields(input);
  validateResumeFields(input);
  validateApprovalFields(input);
  validateEffectFields(input);
  validateCacheFields(input);
  validateShapingFields(input);
}

function validateContextFields(input: ToolBaseInput): void {
  const { name, compactable, compressible, promptAddendum } = input;
  if (promptAddendum !== undefined && (typeof promptAddendum !== 'string' || promptAddendum.trim() === '')) invalid(name, 'promptAddendum must be non-empty text');
  if (compactable !== undefined && typeof compactable !== 'boolean') invalid(name, `compactable must be a boolean, got ${String(compactable)}`);
  if (compressible !== undefined && typeof compressible !== 'boolean' && compressible !== 'allow-code') invalid(name, `compressible must be true, false or 'allow-code', got ${String(compressible)}`);
}

export function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function defineTool<TSchema extends z.ZodType>(input: ToolInput<TSchema>): Tool {
  validateBase(input);
  const { name, description, args, deterministic, cache, cacheTtlMs, version, cacheNamespace, sharedCache, cacheKey, validity, contentKind, fidelity, hasSideEffects = false, acceptsAliases, compactable, compressible, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS, maxResultTokens, strictSchema = true, describeActivity, run, resume, verify, requiresApproval, risk, dryRun, undo, applyUndo, promptAddendum } = input;
  const jsonSchema = strictSchema ? toStrictJsonSchema(args) : toLooseJsonSchema(args);
  return {
    name,
    description,
    argsSchema: args,
    jsonSchema,
    schemaHash: hashSchema(jsonSchema),
    strict: strictSchema,
    deterministic,
    cache,
    cacheTtlMs,
    ...(version == null ? {} : { version }),
    ...(cacheNamespace == null ? {} : { cacheNamespace }),
    ...(sharedCache === true ? { sharedCache } : {}),
    definitionId: `${DEFINITION_ID_PREFIX}${(definitionCount += 1)}`,
    ...(contentKind == null ? {} : { contentKind }),
    ...(fidelity == null ? {} : { fidelity }),
    ...(cacheKey == null ? {} : { cacheKey: (cacheArgs: unknown) => cacheKey(cacheArgs as z.infer<TSchema>) }),
    ...(validity == null ? {} : { validity: (validityArgs: unknown, context: ToolContext) => validity(validityArgs as z.infer<TSchema>, context) }),
    hasSideEffects,
    ...(acceptsAliases === true ? { acceptsAliases } : {}),
    ...(compactable === false ? { compactable } : {}),
    ...(compressible == null || compressible === false ? {} : { compressible }),
    ...(resume == null ? {} : { resume }),
    ...(requiresApproval == null || requiresApproval === false ? {} : { requiresApproval }),
    ...(risk == null ? {} : { risk }),
    ...(promptAddendum == null ? {} : { promptAddendum }),
    ...(verify == null ? {} : { verify: (verifyArgs: unknown, context: ToolContext) => verify(verifyArgs as z.infer<TSchema>, context) }),
    ...(dryRun == null ? {} : { dryRun: (dryArgs: unknown, context: ToolContext) => dryRun(dryArgs as z.infer<TSchema>, context) }),
    ...(undo == null ? {} : { undo: (undoArgs: unknown, result: unknown, context: ToolContext) => undo(undoArgs as z.infer<TSchema>, result, context) }),
    ...(applyUndo == null ? {} : { applyUndo }),
    timeoutMs,
    maxResultTokens,
    describeActivity: describeActivity as DescribeActivity<unknown>,
    run: (parsedArgs, context) => run(parsedArgs as z.infer<TSchema>, context),
  };
}
