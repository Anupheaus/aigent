import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { toLooseJsonSchema } from './loose-schema.js';
import { toStrictJsonSchema } from './strict-schema.js';
import { addErrorDetails, describeThrown } from './tool-error-detail.js';
import type { ToolErrorDetail } from './tool-error-detail.js';
import type { DescribeActivity, Tool, ToolContext, ToolOutcome } from './tool-types.js';

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
  hasSideEffects?: boolean;
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
  describeActivity: DescribeActivity<z.infer<TSchema>>;
  run(args: z.infer<TSchema>, context: ToolContext): Promise<unknown>;
}

export interface BatchToolInput<TItem extends z.ZodType> extends ToolBaseInput {
  item: TItem;
  maxItems: number;
  describeActivity: DescribeActivity<{ items: z.infer<TItem>[] }>;
  runItem(item: z.infer<TItem>, context: ToolContext): Promise<unknown>;
}

function invalid(toolName: string, message: string): never {
  throw createAigentError({ code: 'invalid_definition', message: `Tool '${toolName}': ${message}`, details: { tool: toolName } });
}

function validateBase(input: ToolBaseInput & { describeActivity: unknown }): void {
  const { name, deterministic, cache, cacheTtlMs, hasSideEffects, timeoutMs, describeActivity } = input;
  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) invalid(String(name), `name must match ${TOOL_NAME_PATTERN} (lowercase snake_case), got '${String(name)}'`);
  if (typeof deterministic !== 'boolean') invalid(name, 'deterministic must be declared explicitly (true or false)');
  if (typeof cache !== 'boolean') invalid(name, 'cache must be declared explicitly (true or false)');
  if (typeof describeActivity !== 'function') invalid(name, 'describeActivity is required so the UI can render each call');
  if (hasSideEffects === true && (cache || deterministic)) invalid(name, 'a tool with side effects cannot be cached or deterministic');
  if (cache && !deterministic && (cacheTtlMs == null || cacheTtlMs <= 0)) invalid(name, 'a cached non-deterministic tool needs a positive cacheTtlMs');
  if (timeoutMs !== undefined && !isPositiveInteger(timeoutMs)) invalid(name, `timeoutMs must be a positive integer number of milliseconds, got ${String(timeoutMs)}`);
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function defineTool<TSchema extends z.ZodType>(input: ToolInput<TSchema>): Tool {
  validateBase(input);
  const { name, description, args, deterministic, cache, cacheTtlMs, hasSideEffects = false, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS, maxResultTokens, strictSchema = true, describeActivity, run } = input;
  return {
    name,
    description,
    argsSchema: args,
    jsonSchema: strictSchema ? toStrictJsonSchema(args) : toLooseJsonSchema(args),
    strict: strictSchema,
    deterministic,
    cache,
    cacheTtlMs,
    hasSideEffects,
    timeoutMs,
    maxResultTokens,
    describeActivity: describeActivity as DescribeActivity<unknown>,
    run: (parsedArgs, context) => run(parsedArgs as z.infer<TSchema>, context),
  };
}

type BatchEntry =
  | { index: number; ok: true; result: unknown }
  | { index: number; ok: false; error: ToolErrorDetail };

function batchEntries(result: unknown): BatchEntry[] {
  return Array.isArray(result) ? result as BatchEntry[] : [];
}

function summariseBatch(result: unknown): ToolOutcome {
  const entries = batchEntries(result);
  const failed = entries.filter(entry => !entry.ok).length;
  if (failed === 0) return { success: true, reason: `${entries.length} of ${entries.length} items succeeded` };
  return { success: false, reason: `${failed} of ${entries.length} items failed` };
}

function batchFailures(result: unknown): ToolErrorDetail[] {
  return batchEntries(result).flatMap(entry => (entry.ok ? [] : [addErrorDetails(entry.error, { itemIndex: entry.index })]));
}

export function defineBatchTool<TItem extends z.ZodType>(input: BatchToolInput<TItem>): Tool {
  const { item, maxItems, runItem, describeActivity, ...base } = input;
  // An array schema with min 1 and max below 1 could never be satisfied.
  if (!isPositiveInteger(maxItems)) invalid(base.name, `maxItems must be a positive integer, got ${String(maxItems)}`);
  const argsSchema = z.object({ items: z.array(item).min(1).max(maxItems) }).strict();
  const tool = defineTool({
    ...base,
    args: argsSchema,
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
  return { ...tool, summarise: summariseBatch, nestedFailures: batchFailures };
}
