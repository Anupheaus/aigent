import { createPlanCompleteTool } from '../planning/plan-complete-tool.js';
import type { PlanItemState, TodoItem } from '../planning/plan-schema.js';
import { renderPinned } from '../planning/render-pinned.js';
import { createRunPlanning } from '../planning/run-planning.js';
import type { RunPlanning } from '../planning/run-planning.js';
import { createTodoTool } from '../planning/todo-tool.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { AigentEvent, TaskStatus } from './aigent-events.js';
import { issueContextMessage, renumber } from './run-context.js';
import type { RunContext } from './run-context.js';
import type { TaskInput } from './task-input.js';


export interface SetUpRunPlanningParams {
  registry: ToolRegistry;
  input: TaskInput;
  isTodoEnabled: boolean;
  emit(event: AigentEvent): void;
}

/** The run's planning state and its registry: `plan_complete` with a plan, `todo` unless the agent turned it off. */
export function setUpRunPlanning(params: SetUpRunPlanningParams): { registry: ToolRegistry; planning: RunPlanning } {
  const { registry, input: { plan }, isTodoEnabled, emit } = params;
  const planning = createRunPlanning({ ...(plan == null ? {} : { plan }), isTodoEnabled, emit });
  const tools = [
    ...(plan == null ? [] : [createPlanCompleteTool({ planning })]),
    ...(isTodoEnabled ? [createTodoTool({ planning })] : []),
  ];
  return { planning, registry: tools.length === 0 ? registry : createToolRegistry([...registry.list(), ...tools]) };
}

export interface SyncPinnedParams {
  context: RunContext;
  planning: RunPlanning;
  /** Epoch ms, stamped on a newly pinned message. */
  now: number;
}

/**
 * Inserts the pinned plan definitions before the first request. They never change afterwards (the todo list lives in
 * the volatile block), so later calls find the message unchanged and the prefix stays byte-stable; any rewrite would be
 * a real prefix change, which the stability monitor is left to report.
 */
export function syncPinned(params: SyncPinnedParams): void {
  const { context, planning, now } = params;
  const { state } = context;
  const text = renderPinned(planning.state);
  const index = state.findIndex(({ kind }) => kind === 'pinned');
  const current = state[index];
  if (current != null && current.message.text === text) return;
  if (text == null && current == null) return;
  if (text == null) { state.splice(index, 1); renumber(state); return; }
  const pinned = issueContextMessage({ context, entry: { message: { role: 'user', text }, kind: 'pinned' }, createdAt: now });
  // Directly after the task brief, so the definitions stay in the never-compacted head of the prompt.
  if (current != null) state[index] = pinned;
  else state.splice(state.findIndex(({ kind }) => kind === 'brief') + 1, 0, pinned);
  renumber(state);
}

/** A run that otherwise completed is incomplete while any plan or todo item is not done. */
export function finalStatus(params: { status: TaskStatus; planning: RunPlanning }): TaskStatus {
  const { status, planning: { state: { plan, todo } } } = params;
  if (status !== 'completed') return status;
  return [...plan, ...todo].every(item => item.status === 'done') ? status : 'incomplete';
}

/** `TaskResult.plan` (with a plan) and `TaskResult.todo` (when the agent kept one). */
export function planningResult(planning: RunPlanning): { plan?: PlanItemState[]; todo?: TodoItem[] } {
  const { hasPlan, state: { plan, todo } } = planning;
  return { ...(hasPlan ? { plan: structuredClone(plan) } : {}), ...(todo.length === 0 ? {} : { todo: structuredClone(todo) }) };
}
