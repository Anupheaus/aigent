import type { PlanUpdate } from '../streaming/directive-schemas.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import type { PlanItem, PlanItemState, PlanStatus, TodoItem } from './plan-schema.js';

/** A run's plan and todo list; changed only through `applyPlanUpdates` and `applyTodoOps`. */
export interface PlanningState {
  plan: PlanItemState[];
  todo: TodoItem[];
  /** Number of the next generated todo id (`t<n>`). */
  nextTodoNumber: number;
}

/** One update's or op's outcome; `changed` is false for an idempotent repeat. */
export type ItemResult = { ok: true; id: string; changed: boolean } | { ok: false; error: ToolErrorDetail };

/** Statuses an item (plan or todo) may not leave for these without giving a reason. */
const REGRESSIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  pending: [],
  in_progress: [],
  done: ['pending', 'in_progress', 'blocked'],
  blocked: ['pending', 'in_progress'],
};

/** Whether moving from `from` to `to` goes back from done or blocked, which needs a reason. */
export function isRegression(params: { from: PlanStatus; to: PlanStatus }): boolean {
  const { from, to } = params;
  return REGRESSIONS[from].includes(to);
}

/** Trimmed text, or undefined when it is absent or only whitespace (which never counts as evidence or a reason). */
export function meaningfulText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed == null || trimmed === '' ? undefined : trimmed;
}

export function createPlanningState(params: { plan?: PlanItem[] }): PlanningState {
  const { plan = [] } = params;
  return { plan: plan.map(item => ({ ...structuredClone(item), status: 'pending' })), todo: [], nextTodoNumber: 1 };
}

/** A validation failure the model can act on. */
export function itemFailure(params: { code: string; message: string; suggestion?: string }): ItemResult {
  const { code, message, suggestion } = params;
  return { ok: false, error: { category: 'validation', code, message, retryable: true, ...(suggestion == null ? {} : { suggestion }) } };
}

function applyPlanUpdate(params: { state: PlanningState; update: PlanUpdate }): ItemResult {
  const { state: { plan }, update: { id, status } } = params;
  const evidence = meaningfulText(params.update.evidence);
  const item = plan.find(planItem => planItem.id === id);
  if (item == null) return itemFailure({ code: 'unknown_plan_item', message: `There is no plan item '${id}'`, suggestion: `Valid plan item ids: ${plan.map(planItem => planItem.id).join(', ')}` });
  if (item.status === status) {
    // Idempotent: repeating a status is fine; new evidence is kept.
    if (evidence != null) item.evidence = evidence;
    return { ok: true, id, changed: evidence != null };
  }
  if (status === 'done' && evidence == null) {
    return itemFailure({ code: 'evidence_required', message: `Marking plan item '${id}' done needs evidence`, suggestion: 'Say what shows the acceptance criteria are met, e.g. the file and line or the test that passed.' });
  }
  if (isRegression({ from: item.status, to: status }) && evidence == null) {
    return itemFailure({
      code: 'status_regression', message: `Plan item '${id}' is ${item.status}; moving it back to ${status} needs evidence giving the reason`,
      suggestion: 'Repeat the update with evidence explaining why the item is no longer done or blocked.',
    });
  }
  item.status = status;
  if (evidence != null) item.evidence = evidence;
  return { ok: true, id, changed: true };
}

/** Applies plan updates in order, each validated on its own (one bad update never blocks the rest). */
export function applyPlanUpdates(params: { state: PlanningState; updates: PlanUpdate[] }): ItemResult[] {
  const { state, updates } = params;
  return updates.map(update => applyPlanUpdate({ state, update }));
}
