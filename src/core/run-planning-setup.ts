import { createPlanCompleteTool } from '../planning/plan-complete-tool.js';
import type { PlanItemState, TodoItem } from '../planning/plan-schema.js';
import { renderPinned } from '../planning/render-pinned.js';
import { createRunPlanning } from '../planning/run-planning.js';
import type { RunPlanning } from '../planning/run-planning.js';
import { createTodoTool } from '../planning/todo-tool.js';
import type { ProviderMessage } from '../providers/provider-types.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { AigentEvent, TaskStatus } from './aigent-events.js';
import type { TaskInput } from './task-input.js';

/** A stored history message; `pinned` marks the plan definitions, which compaction must never drop. */
export interface RunMessage extends ProviderMessage {
  pinned?: boolean;
}

/** Index of the pinned definitions: directly after the system prompt and the task brief. */
const PINNED_INDEX = 2;

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
  messages: RunMessage[];
  planning: RunPlanning;
}

/**
 * Inserts the pinned plan definitions before the first request. They never change afterwards (the todo list lives in
 * the volatile block), so later calls find the message unchanged and the prefix stays byte-stable; any rewrite would be
 * a real prefix change, which the stability monitor is left to report.
 */
export function syncPinned(params: SyncPinnedParams): void {
  const { messages, planning } = params;
  const text = renderPinned(planning.state);
  const current = messages[PINNED_INDEX];
  const hasPinned = current?.pinned === true;
  if (hasPinned && current.text === text) return;
  if (text == null && !hasPinned) return;
  if (text == null) { messages.splice(PINNED_INDEX, 1); return; }
  const pinned: RunMessage = { role: 'user', text, pinned: true };
  if (hasPinned) messages[PINNED_INDEX] = pinned;
  else messages.splice(PINNED_INDEX, 0, pinned);
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
