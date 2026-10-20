import { addErrorDetails } from './tool-error-detail.js';
import type { ToolErrorDetail } from './tool-error-detail.js';
import type { ItemCounts, Tool, ToolOutcome } from './tool-types.js';

/** One entry of a batch-style result: the item's result or its failure. */
export type BatchEntry =
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

function countBatchItems(result: unknown): ItemCounts {
  const entries = batchEntries(result);
  return { total: entries.length, failed: entries.filter(entry => !entry.ok).length };
}

function batchFailures(result: unknown): ToolErrorDetail[] {
  return batchEntries(result).flatMap(entry => (entry.ok ? [] : [addErrorDetails(entry.error, { itemIndex: entry.index })]));
}

/** Outcome, nested failures and item counts for tools whose result is a `BatchEntry[]`. */
export const BATCH_RESULT_HELPERS: Required<Pick<Tool, 'summarise' | 'nestedFailures' | 'countItems'>> = {
  summarise: summariseBatch,
  nestedFailures: batchFailures,
  countItems: countBatchItems,
};

/** The batch outcome, with the first failure's reason so an activity row says why (e.g. "outside every allowed root"). */
function summariseWithReason(result: unknown): ToolOutcome {
  const entries = batchEntries(result);
  const failures = entries.flatMap(entry => (entry.ok ? [] : [entry.error]));
  const [first] = failures;
  if (first == null) return { success: true, reason: `${entries.length} of ${entries.length} items succeeded` };
  return { success: false, reason: `${failures.length} of ${entries.length} items failed: ${first.message}` };
}

/** `BATCH_RESULT_HELPERS` whose outcome names the first failure (the tool packs' batch tools). */
export const BATCH_RESULT_HELPERS_WITH_REASONS: Required<Pick<Tool, 'summarise' | 'nestedFailures' | 'countItems'>> = { ...BATCH_RESULT_HELPERS, summarise: summariseWithReason };
