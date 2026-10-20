import { z } from 'zod';
import type { DryRunOutput } from '../effects/planned-effects.js';
import type { UndoContext, UndoDescriptor, UndoOutcome } from '../effects/undo-types.js';
import { BATCH_RESULT_HELPERS } from './batch-entries.js';
import type { BatchEntry } from './batch-entries.js';
import { batchDryRun } from './batch-dry-run.js';
import { defineTool, invalid, isPositiveInteger } from './define-tool.js';
import type { ToolBaseInput } from './define-tool.js';
import { describeThrown } from './tool-error-detail.js';
import type { DescribeActivity, Tool, ToolContext, ToolVerifyResult } from './tool-types.js';

export interface BatchToolInput<TItem extends z.ZodType> extends ToolBaseInput {
  item: TItem;
  /** Cached tools only: normalises the arguments into the cache key (default: the arguments). */
  cacheKey?(args: BatchArgs<TItem>): unknown;
  /** Cached tools only: a token that changes when the data behind a result changes. */
  validity?(args: BatchArgs<TItem>, context: ToolContext): Promise<string>;
  maxItems: number;
  describeActivity: DescribeActivity<{ items: z.infer<TItem>[] }>;
  runItem(item: z.infer<TItem>, context: ToolContext): Promise<unknown>;
  /** Tools with side effects: what one item would do, without doing it; failures are per item as with `runItem`. */
  dryRunItem?(item: z.infer<TItem>, context: ToolContext): Promise<DryRunOutput>;
  /** Default false: items run in parallel. True runs them one at a time in order (e.g. edits that may touch one file). */
  sequential?: boolean;
  /** Required with `resume: 'verify'`: whether an interrupted call's effects already happened. */
  verify?(args: BatchArgs<TItem>, context: ToolContext): Promise<ToolVerifyResult>;
  /** Tools with side effects: after a successful call, the plain-JSON data that reverses it (with `applyUndo`). */
  undo?(args: BatchArgs<TItem>, result: unknown, context: ToolContext): Promise<UndoDescriptor | undefined>;
  /** Reverses one recorded call from its descriptor (`agent.undo`). */
  applyUndo?(descriptor: UndoDescriptor, context: UndoContext): Promise<UndoOutcome>;
}

/** The arguments of a batch tool. */
export interface BatchArgs<TItem extends z.ZodType> {
  items: z.infer<TItem>[];
}

export function defineBatchTool<TItem extends z.ZodType>(input: BatchToolInput<TItem>): Tool {
  const { item, maxItems, runItem, dryRunItem, describeActivity, cacheKey, validity, sequential = false, verify, undo, ...base } = input;
  // An array schema with min 1 and max below 1 could never be satisfied.
  if (!isPositiveInteger(maxItems)) invalid(base.name, `maxItems must be a positive integer, got ${String(maxItems)}`);
  const argsSchema = z.object({ items: z.array(item).min(1).max(maxItems) }).strict();
  const tool = defineTool({
    ...base,
    args: argsSchema,
    ...(cacheKey == null ? {} : { cacheKey: (batchArgs: z.infer<typeof argsSchema>) => cacheKey(batchArgs as BatchArgs<TItem>) }),
    ...(validity == null ? {} : { validity: (batchArgs: z.infer<typeof argsSchema>, context: ToolContext) => validity(batchArgs as BatchArgs<TItem>, context) }),
    describeActivity: describeActivity as DescribeActivity<z.infer<typeof argsSchema>>,
    ...(dryRunItem == null ? {} : { dryRun: (parsed: z.infer<typeof argsSchema>, context: ToolContext) => batchDryRun({ items: parsed.items, context, dryRunItem: (batchItem, itemContext) => dryRunItem(batchItem as z.infer<TItem>, itemContext) }) }),
    ...(verify == null ? {} : { verify: (batchArgs: z.infer<typeof argsSchema>, context: ToolContext) => verify(batchArgs as BatchArgs<TItem>, context) }),
    ...(undo == null ? {} : { undo: (batchArgs: z.infer<typeof argsSchema>, result: unknown, context: ToolContext) => undo(batchArgs as BatchArgs<TItem>, result, context) }),
    run: async (parsed, context) => {
      // Each failure is isolated into its own entry.
      const runOne = async (batchItem: unknown, index: number): Promise<BatchEntry> => {
        try {
          return { index, ok: true as const, result: await runItem(batchItem as z.infer<TItem>, context) };
        } catch (error) {
          return { index, ok: false as const, error: describeThrown(error) };
        }
      };
      // Independent items run in parallel; sequential tools take them one at a time, in order.
      if (!sequential) return Promise.all(parsed.items.map(runOne));
      const entries: BatchEntry[] = [];
      for (const [index, batchItem] of parsed.items.entries()) entries.push(await runOne(batchItem, index));
      return entries;
    },
  });
  return { ...tool, ...BATCH_RESULT_HELPERS };
}
