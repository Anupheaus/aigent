import { describe, expect, it } from 'vitest';
import { createPlanningState } from './plan-state.js';
import { applyTodoOps, MAX_TODO_ITEMS } from './todo-state.js';

function codes(results: ReturnType<typeof applyTodoOps>): string[] {
  return results.map(result => (result.ok ? `ok:${result.id}` : result.error.code));
}

describe('applyTodoOps', () => {
  it('adds items with generated ids t1, t2... or the given id, and bumps the definitions version', () => {
    const planning = createPlanningState({});
    const results = applyTodoOps({ state: planning, ops: [{ op: 'add', label: 'Read config' }, { op: 'add', id: 'mine', label: 'Write fix', description: 'in src/' }, { op: 'add', label: 'Test' }] });
    expect(codes(results)).toEqual(['ok:t1', 'ok:mine', 'ok:t2']);
    expect(planning.todo).toEqual([
      { id: 't1', label: 'Read config', status: 'pending' },
      { id: 'mine', label: 'Write fix', description: 'in src/', status: 'pending' },
      { id: 't2', label: 'Test', status: 'pending' },
    ]);
    expect(planning.definitionsVersion).toBe(1);
  });

  it('edits, sets status and deletes, with precise per-op errors', () => {
    const planning = createPlanningState({});
    applyTodoOps({ state: planning, ops: [{ op: 'add', label: 'A' }, { op: 'add', label: 'B' }] });
    const results = applyTodoOps({ state: planning, ops: [
      { op: 'edit', id: 't1', label: 'A2' },
      { op: 'set_status', id: 't2', status: 'done' },
      { op: 'delete', id: 't1' },
      { op: 'delete', id: 't9' },
      { op: 'edit' },
      { op: 'edit', id: 't2' },
      { op: 'set_status', id: 't2' },
      { op: 'add' },
      { op: 'add', id: 't2', label: 'dup' },
    ] });
    expect(codes(results)).toEqual(['ok:t1', 'ok:t2', 'ok:t1', 'unknown_todo_item', 'id_required', 'nothing_to_edit', 'status_required', 'label_required', 'duplicate_todo_id']);
    expect(planning.todo).toEqual([{ id: 't2', label: 'B', status: 'done' }]);
    const unknown = results[3];
    expect(unknown?.ok === false && unknown.error.suggestion).toBe('Todo ids: t2');
  });

  it('never silently drops items: a full list gives todo_full telling the agent to delete or merge', () => {
    const planning = createPlanningState({});
    applyTodoOps({ state: planning, ops: Array.from({ length: MAX_TODO_ITEMS }, (_unused, index) => ({ op: 'add' as const, label: `item ${index}` })) });
    const [overflow] = applyTodoOps({ state: planning, ops: [{ op: 'add', label: 'one more' }] });
    expect(overflow).toEqual({ ok: false, error: expect.objectContaining({ code: 'todo_full', message: expect.stringContaining(`${MAX_TODO_ITEMS}`), suggestion: expect.stringContaining('delete or merge') }) });
    expect(planning.todo).toHaveLength(MAX_TODO_ITEMS);
  });

  it('caps the rendered size of the list too', () => {
    const planning = createPlanningState({});
    const long = 'x'.repeat(1_000);
    const results = applyTodoOps({ state: planning, ops: Array.from({ length: 20 }, () => ({ op: 'add' as const, label: 'L', description: long })) });
    expect(codes(results)).toContain('todo_full');
    expect(planning.todo.length).toBeLessThan(20);
  });
});
