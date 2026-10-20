import { z } from 'zod';
import { hashSchema } from '../cache/cache-key.js';
import { CONTENT_KINDS, FIDELITIES } from '../shapers/shaper-types.js';
import type { ContentKind, Fidelity } from '../shapers/shaper-types.js';
import { createAigentError } from '../core/aigent-error.js';
import { toLooseJsonSchema } from './loose-schema.js';
import { toStrictJsonSchema } from './strict-schema.js';
import { BATCH_RESULT_HELPERS } from './batch-entries.js';
import { describeThrown } from './tool-error-detail.js';
import type { DescribeActivity, Tool, ToolContext } from './tool-types.js';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

interface ToolBaseInput {
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
  /**
   * Default true: the argument schema must fit the strict subset (every object `.strict()`, optionals sent as null) and
   * providers send the tool with strict decoding. `false` is an explicit opt-out for tools whose arguments a strict schema
   * cannot describe; the built-in `aigent_multi` is the only library tool that uses it. Arguments are still validated by zod.
   */
  strictSchema?: boolean;
}

export interface ToolInput<TSchema extends z.ZodType> extends ToolBaseInput {
  args: TSchema;
  /** Cached tools only: normalises the arguments into the cache key (default: the arguments). */
  cacheKey?(args: z.infer<TSchema>): unknown;
  /** Cached tools only: a token that changes when the data behind a result changes (e.g. mtime + size). */
  validity?(args: z.infer<TSchema>, context: ToolContext): Promise<string>;
  describeActivity: DescribeActivity<z.infer<TSchema>>;
  run(args: z.infer<TSchema>, context: ToolContext): Promise<unknown>;
}

export interface BatchToolInput<TItem extends z.ZodType> extends ToolBaseInput {
  item: TItem;
  /** Cached tools only: normalises the arguments into the cache key (default: the arguments). */
  cacheKey?(args: BatchArgs<TItem>): unknown;
  /** Cached tools only: a token that changes when the data behind a result changes. */
  validity?(args: BatchArgs<TItem>, context: ToolContext): Promise<string>;
  maxItems: number;
  describeActivity: DescribeActivity<{ items: z.infer<TItem>[] }>;
  runItem(item: z.infer<TItem>, context: ToolContext): Promise<unknown>;
}

/** The arguments of a batch tool. */
export interface BatchArgs<TItem extends z.ZodType> {
  items: z.infer<TItem>[];
}

/** The cache fields every tool input may carry, checked without their argument types. */
interface CacheFieldsInput {
  cacheKey?: unknown;
  validity?: unknown;
}

function invalid(toolName: string, message: string): never {
  throw createAigentError({ code: 'invalid_definition', message: `Tool '${toolName}': ${message}`, details: { tool: toolName } });
}

function validateCacheFields(input: ToolBaseInput & CacheFieldsInput): void {
  const { name, cache, version, cacheKey, validity } = input;
  if (version !== undefined && (typeof version !== 'string' || version === '')) invalid(name, `version must be a non-empty string, got ${JSON.stringify(version)}`);
  if (cacheKey !== undefined && typeof cacheKey !== 'function') invalid(name, 'cacheKey must be a function of the arguments');
  if (validity !== undefined && typeof validity !== 'function') invalid(name, 'validity must be a function returning a promise of a token');
  if (!cache && (cacheKey !== undefined || validity !== undefined)) invalid(name, 'cacheKey and validity only apply to cached tools (cache: true)');
}

function validateShapingFields(input: ToolBaseInput): void {
  const { name, contentKind, fidelity } = input;
  if (contentKind !== undefined && !(CONTENT_KINDS as readonly unknown[]).includes(contentKind)) invalid(name, `contentKind must be one of ${CONTENT_KINDS.join(', ')}, got ${String(contentKind)}`);
  if (fidelity !== undefined && !(FIDELITIES as readonly unknown[]).includes(fidelity)) invalid(name, `fidelity must be one of ${FIDELITIES.join(', ')}, got ${String(fidelity)}`);
  if (fidelity === 'lossy-ok' && contentKind === undefined) invalid(name, "fidelity 'lossy-ok' needs a contentKind, so only shapers declared for that kind can run");
}

function validateBase(input: ToolBaseInput & CacheFieldsInput & { describeActivity: unknown }): void {
  const { name, deterministic, cache, cacheTtlMs, hasSideEffects, acceptsAliases, timeoutMs, describeActivity } = input;
  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) invalid(String(name), `name must match ${TOOL_NAME_PATTERN} (lowercase snake_case), got '${String(name)}'`);
  if (typeof deterministic !== 'boolean') invalid(name, 'deterministic must be declared explicitly (true or false)');
  if (typeof cache !== 'boolean') invalid(name, 'cache must be declared explicitly (true or false)');
  if (typeof describeActivity !== 'function') invalid(name, 'describeActivity is required so the UI can render each call');
  if (hasSideEffects === true && (cache || deterministic)) invalid(name, 'a tool with side effects cannot be cached or deterministic');
  if (cache && !deterministic && (cacheTtlMs == null || cacheTtlMs <= 0)) invalid(name, 'a cached non-deterministic tool needs a positive cacheTtlMs');
  if (acceptsAliases !== undefined && typeof acceptsAliases !== 'boolean') invalid(name, `acceptsAliases must be a boolean, got ${String(acceptsAliases)}`);
  if (timeoutMs !== undefined && !isPositiveInteger(timeoutMs)) invalid(name, `timeoutMs must be a positive integer number of milliseconds, got ${String(timeoutMs)}`);
  validateCacheFields(input);
  validateShapingFields(input);
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function defineTool<TSchema extends z.ZodType>(input: ToolInput<TSchema>): Tool {
  validateBase(input);
  const { name, description, args, deterministic, cache, cacheTtlMs, version, cacheKey, validity, contentKind, fidelity, hasSideEffects = false, acceptsAliases, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS, maxResultTokens, strictSchema = true, describeActivity, run } = input;
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
    ...(contentKind == null ? {} : { contentKind }),
    ...(fidelity == null ? {} : { fidelity }),
    ...(cacheKey == null ? {} : { cacheKey: (cacheArgs: unknown) => cacheKey(cacheArgs as z.infer<TSchema>) }),
    ...(validity == null ? {} : { validity: (validityArgs: unknown, context: ToolContext) => validity(validityArgs as z.infer<TSchema>, context) }),
    hasSideEffects,
    ...(acceptsAliases === true ? { acceptsAliases } : {}),
    timeoutMs,
    maxResultTokens,
    describeActivity: describeActivity as DescribeActivity<unknown>,
    run: (parsedArgs, context) => run(parsedArgs as z.infer<TSchema>, context),
  };
}

export function defineBatchTool<TItem extends z.ZodType>(input: BatchToolInput<TItem>): Tool {
  const { item, maxItems, runItem, describeActivity, cacheKey, validity, ...base } = input;
  // An array schema with min 1 and max below 1 could never be satisfied.
  if (!isPositiveInteger(maxItems)) invalid(base.name, `maxItems must be a positive integer, got ${String(maxItems)}`);
  const argsSchema = z.object({ items: z.array(item).min(1).max(maxItems) }).strict();
  const tool = defineTool({
    ...base,
    args: argsSchema,
    ...(cacheKey == null ? {} : { cacheKey: (batchArgs: z.infer<typeof argsSchema>) => cacheKey(batchArgs as BatchArgs<TItem>) }),
    ...(validity == null ? {} : { validity: (batchArgs: z.infer<typeof argsSchema>, context: ToolContext) => validity(batchArgs as BatchArgs<TItem>, context) }),
    describeActivity: describeActivity as DescribeActivity<z.infer<typeof argsSchema>>,
    // Items are independent, so they run in parallel; each failure is isolated into its own entry.
    run: async (parsed, context) => Promise.all(parsed.items.map(async (batchItem, index) => {
      try {
        return { index, ok: true as const, result: await runItem(batchItem as z.infer<TItem>, context) };
      } catch (error) {
        return { index, ok: false as const, error: describeThrown(error) };
      }
    })),
  });
  return { ...tool, ...BATCH_RESULT_HELPERS };
}
