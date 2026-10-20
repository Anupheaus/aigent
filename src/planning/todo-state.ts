import type { TodoOp } from '../streaming/directive-schemas.js';
import type { TodoItem } from './plan-schema.js';
import { isRegression, itemFailure, meaningfulText } from './plan-state.js';
import type { ItemResult, PlanningState } from './plan-state.js';
import { renderTodoBody } from './render-pinned.js';

/** Most items the todo list holds. */
export const MAX_TODO_ITEMS = 100;
/** Most characters the todo section of the volatile block may take. */
export const MAX_TODO_CHARS = 8_000;
const GENERATED_ID_PREFIX = 't';

interface OpParams {
  state: PlanningState;
  op: TodoOp;
}

function knownIds(todo: TodoItem[]): string {
  return todo.length === 0 ? 'The todo list is empty.' : `Todo ids: ${todo.map(({ id }) => id).join(', ')}`;
}

function nextGeneratedId(state: PlanningState): string {
  for (;;) {
    const id = `${GENERATED_ID_PREFIX}${state.nextTodoNumber}`;
    state.nextTodoNumber += 1;
    if (!state.todo.some(item => item.id === id)) return id;
  }
}

function todoFull(reason: string): ItemResult {
  return itemFailure({ code: 'todo_full', message: `The todo list is full (${reason}); the item was not added`, suggestion: 'delete or merge finished or overlapping items, then add it again' });
}

function addItem(params: OpParams): ItemResult {
  const { state, op: { id, label, description, status = 'pending' } } = params;
  if (label == null) return itemFailure({ code: 'label_required', message: "op 'add' needs a label" });
  if (id != null && state.todo.some(item => item.id === id)) return itemFailure({ code: 'duplicate_todo_id', message: `A todo item '${id}' already exists`, suggestion: 'Leave id out to get a generated one, or edit the existing item.' });
  if (state.todo.length >= MAX_TODO_ITEMS) return todoFull(`${MAX_TODO_ITEMS} items at most`);
  const item: TodoItem = { id: id ?? '', label, ...(description == null ? {} : { description }), status };
  // Measured before an id is generated, so a refused add does not use one up.
  if (renderTodoBody([...state.todo, { ...item, id: id ?? `${GENERATED_ID_PREFIX}${state.nextTodoNumber}` }]).length > MAX_TODO_CHARS) {
    return todoFull(`its definitions may take ${MAX_TODO_CHARS} characters at most`);
  }
  item.id = id ?? nextGeneratedId(state);
  state.todo.push(item);
  return { ok: true, id: item.id, changed: true };
}

function findItem(params: OpParams): TodoItem | ItemResult {
  const { state: { todo }, op: { op, id } } = params;
  if (id == null) return itemFailure({ code: 'id_required', message: `op '${op}' needs the id of an existing item`, suggestion: knownIds(todo) });
  return todo.find(item => item.id === id) ?? itemFailure({ code: 'unknown_todo_item', message: `There is no todo item '${id}'`, suggestion: knownIds(todo) });
}

function isResult(value: TodoItem | ItemResult): value is ItemResult {
  return 'ok' in value;
}

function changeItem(params: OpParams): ItemResult {
  const { state, op: { op, label, description, status, reason } } = params;
  const found = findItem(params);
  if (isResult(found)) return found;
  const { id } = found;
  if (op === 'delete') {
    state.todo = state.todo.filter(item => item !== found);
    return { ok: true, id, changed: true };
  }
  if (op === 'set_status') {
    if (status == null) return itemFailure({ code: 'status_required', message: `op 'set_status' on '${id}' needs a status` });
    if (isRegression({ from: found.status, to: status }) && meaningfulText(reason) == null) {
      return itemFailure({
        code: 'status_regression', message: `Todo item '${id}' is ${found.status}; moving it back to ${status} needs a reason`,
        suggestion: 'Repeat the op with a reason explaining why the item is no longer done or blocked.',
      });
    }
    const changed = found.status !== status;
    found.status = status;
    return { ok: true, id, changed };
  }
  if (label == null && description == null) return itemFailure({ code: 'nothing_to_edit', message: `op 'edit' on '${id}' needs a label or a description` });
  const edited: TodoItem = { ...found, ...(label == null ? {} : { label }), ...(description == null ? {} : { description }) };
  if (renderTodoBody(state.todo.map(item => (item === found ? edited : item))).length > MAX_TODO_CHARS) {
    return todoFull(`its definitions may take ${MAX_TODO_CHARS} characters at most`);
  }
  Object.assign(found, edited);
  return { ok: true, id, changed: true };
}

/** Applies todo ops in order, each validated on its own; a full list is an error, never a silent drop. */
export function applyTodoOps(params: { state: PlanningState; ops: TodoOp[] }): ItemResult[] {
  const { state, ops } = params;
  return ops.map(op => (op.op === 'add' ? addItem({ state, op }) : changeItem({ state, op })));
}
