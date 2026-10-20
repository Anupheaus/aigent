import type { AigentEvent } from '../core/aigent-events.js';
import type { VolatileSection } from '../context/volatile-block.js';
import type { PlanUpdate, TodoOp } from '../streaming/directive-schemas.js';
import type { PlanItem } from './plan-schema.js';
import { applyPlanUpdates, createPlanningState } from './plan-state.js';
import type { ItemResult, PlanningState } from './plan-state.js';
import { renderStatusSections } from './render-pinned.js';
import { applyTodoOps } from './todo-state.js';

/** One run's plan and todo list, shared by the tools, the directives and the prompt rendering. */
export interface RunPlanning {
  state: PlanningState;
  /** A plan was supplied, so `plan_complete` is registered. */
  hasPlan: boolean;
  /** The agent has the `todo` tool. */
  isTodoEnabled: boolean;
  /** Applies plan updates (same rules for tool and directive) and emits `plan-update` when something changed. */
  applyPlan(updates: PlanUpdate[]): ItemResult[];
  /** Applies todo ops and emits `todo-update` when something changed. */
  applyTodo(ops: TodoOp[]): ItemResult[];
  /** One-line corrections for rejected directives, shown once in the next request's volatile block. */
  addCorrections(lines: string[]): void;
  /** Plan and todo statuses, then pending corrections (which are consumed). */
  extras(): VolatileSection[];
}

export interface CreateRunPlanningParams {
  plan?: PlanItem[];
  isTodoEnabled: boolean;
  emit(event: AigentEvent): void;
}

function changedIds(results: ItemResult[]): string[] {
  return [...new Set(results.flatMap(result => (result.ok && result.changed ? [result.id] : [])))];
}

export function createRunPlanning(params: CreateRunPlanningParams): RunPlanning {
  const { plan, isTodoEnabled, emit } = params;
  const state = createPlanningState(plan == null ? {} : { plan });
  let corrections: string[] = [];

  function applyPlan(updates: PlanUpdate[]): ItemResult[] {
    const results = applyPlanUpdates({ state, updates });
    const changed = changedIds(results);
    if (changed.length > 0) emit({ type: 'plan-update', items: structuredClone(state.plan), changed });
    return results;
  }

  function applyTodo(ops: TodoOp[]): ItemResult[] {
    const results = applyTodoOps({ state, ops });
    const changed = changedIds(results);
    if (changed.length > 0) emit({ type: 'todo-update', items: structuredClone(state.todo), changed });
    return results;
  }

  function extras(): VolatileSection[] {
    const sections = renderStatusSections(state);
    if (corrections.length === 0) return sections;
    const body = corrections.join('\n');
    corrections = [];
    return [...sections, { title: 'Corrections', body }];
  }

  return {
    state, hasPlan: plan != null, isTodoEnabled, applyPlan, applyTodo, extras,
    addCorrections: lines => { corrections.push(...lines); },
  };
}
