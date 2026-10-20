import type { VolatileSection } from '../context/volatile-block.js';
import type { PlanItemState, TodoItem } from './plan-schema.js';
import type { PlanningState } from './plan-state.js';

const PLAN_INSTRUCTIONS = 'Report progress with the plan_complete tool or an ::aigent plan directive; marking an item done needs evidence.';
const TODO_INSTRUCTIONS = 'Your own list; change it with the todo tool or an ::aigent todo directive.';

function planLines(item: PlanItemState): string[] {
  const { id, label, description, acceptanceCriteria } = item;
  return [`- ${id}: ${label}`, `  ${description}`, '  Acceptance criteria:', ...acceptanceCriteria.map(criterion => `  - ${criterion}`)];
}

/** One todo definition line. */
export function todoLine(item: Pick<TodoItem, 'id' | 'label' | 'description'>): string {
  const { id, label, description } = item;
  return `- ${id}: ${label}${description == null ? '' : ` (${description})`}`;
}

/** The todo definitions as pinned, for the size cap. */
export function renderTodoDefinitions(todo: TodoItem[]): string {
  return [`# Todo`, TODO_INSTRUCTIONS, ...todo.map(todoLine)].join('\n');
}

/**
 * The pinned definitions message: plan ids, labels, descriptions and criteria, and todo ids and labels. Statuses are
 * never here (they go in the volatile block), so it changes only when definitions do. Undefined when there is nothing.
 */
export function renderPinned(state: PlanningState): string | undefined {
  const { plan, todo } = state;
  const sections: string[] = [];
  if (plan.length > 0) sections.push(['# Plan', PLAN_INSTRUCTIONS, ...plan.flatMap(planLines)].join('\n'));
  if (todo.length > 0) sections.push(renderTodoDefinitions(todo));
  return sections.length === 0 ? undefined : sections.join('\n\n');
}

/** `## Plan status` and `## Todo status` for the volatile block. */
export function renderStatusSections(state: PlanningState): VolatileSection[] {
  const { plan, todo } = state;
  const sections: VolatileSection[] = [];
  if (plan.length > 0) sections.push({ title: 'Plan status', body: plan.map(({ id, status }) => `- ${id}: ${status}`).join('\n') });
  if (todo.length > 0) sections.push({ title: 'Todo status', body: todo.map(({ id, status }) => `- ${id}: ${status}`).join('\n') });
  return sections;
}
