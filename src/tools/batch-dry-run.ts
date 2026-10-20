import type { DryRunOutput, PlannedEffectInput } from '../effects/planned-effects.js';
import { describeThrown } from './tool-error-detail.js';
import type { ToolContext } from './tool-types.js';

/**
 * A batch tool's dry run: each item through `dryRunItem` in parallel, failures isolated per item as with `runItem`.
 * The simulated result has one entry per item; the effects are every item's, in item order.
 */
export async function batchDryRun(params: { items: unknown[]; context: ToolContext; dryRunItem(item: unknown, context: ToolContext): Promise<DryRunOutput> }): Promise<DryRunOutput> {
  const { items, context, dryRunItem } = params;
  const entries = await Promise.all(items.map(async (batchItem, index) => {
    try {
      const output = await dryRunItem(batchItem, context);
      const effects: PlannedEffectInput[] = Array.isArray(output) ? output : output.effects;
      return { entry: { index, ok: true as const, ...(Array.isArray(output) ? {} : { result: output.result }) }, effects };
    } catch (error) {
      return { entry: { index, ok: false as const, error: describeThrown(error) }, effects: [] };
    }
  }));
  return { result: entries.map(({ entry }) => entry), effects: entries.flatMap(({ effects }) => effects) };
}
