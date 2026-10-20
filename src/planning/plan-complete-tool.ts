import { z } from 'zod';
import { planUpdateSchema } from '../streaming/directive-schemas.js';
import { BATCH_RESULT_HELPERS } from '../tools/batch-entries.js';
import type { BatchEntry } from '../tools/batch-entries.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import type { ItemResult } from './plan-state.js';
import type { RunPlanning } from './run-planning.js';

export const PLAN_COMPLETE_TOOL_NAME = 'plan_complete';
const MAX_UPDATES = 50;

/** One update's or op's entry in a batch-style result. */
export function toBatchEntries(results: ItemResult[]): BatchEntry[] {
  return results.map((result, index) => (result.ok ? { index, ok: true, result: { id: result.id, changed: result.changed } } : { index, ok: false, error: result.error }));
}

/** Built-in tool through which the agent reports plan progress; registered only when the task supplies a plan. */
export function createPlanCompleteTool(params: { planning: Pick<RunPlanning, 'applyPlan'> }): Tool {
  const { planning } = params;
  const tool = defineTool({
    name: PLAN_COMPLETE_TOOL_NAME,
    description: 'Update the status of plan items: pending, in_progress, done (needs evidence) or blocked. Moving an item back from done or blocked needs evidence giving the reason. One result per update.',
    args: z.object({ updates: z.array(planUpdateSchema).min(1).max(MAX_UPDATES) }).strict(),
    deterministic: false,
    cache: false,
    describeActivity: ({ updates }) => ({ title: `Updating ${updates.length} plan items`, detail: updates.map(({ id, status }) => `${id}: ${status}`).join(', ') }),
    // Applied as the call starts (no await before it), so a directive and a call in the same turn apply in arrival order.
    run: async ({ updates }) => toBatchEntries(planning.applyPlan(updates)),
  });
  return { ...tool, ...BATCH_RESULT_HELPERS };
}
