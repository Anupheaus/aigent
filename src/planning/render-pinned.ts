import type { VolatileSection } from '../context/volatile-block.js';
import type { PlanItemState, TodoItem } from './plan-schema.js';
import type { PlanningState } from './plan-state.js';

const PLAN_INSTRUCTIONS = 'Report progress with the plan_complete tool or an ::aigent plan directive; marking an item done needs evidence.';
const TODO_INSTRUCTIONS = 'Your own list; change it with the todo tool or an ::aigent todo directive.';

function planLines(item: PlanItemState): string[] {
  const { id, label, description, acceptanceCriteria } = item;
  return [`- ${id}: ${label}`, `  ${description}`, '  Acceptance criteria:', ...acceptanceCriteria.map(criterion => `  - ${criterion}`)];
}

/** Line breaks in agent-written text become spaces, so an id or label can never forge lines or headings of the block. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

/** One todo line: id, status, label and description. */
function todoLine(item: TodoItem): string {
  const { id, status, label, description } = item;
  return `- ${oneLine(id)} [${status}]: ${oneLine(label)}${description == null ? '' : ` (${oneLine(description)})`}`;
}

/** The todo section body (instructions and one line per item); also what the size cap measures. */
export function renderTodoBody(todo: TodoItem[]): string {
  return [TODO_INSTRUCTIONS, ...todo.map(todoLine)].join('\n');
}

/**
 * The pinned definitions message: plan ids, labels, descriptions and criteria. The consumer's plan never changes during
 * a run, so the message is inserted once and stays byte-stable. Statuses and the agent's own todo list (which changes
 * often) are never here: they go in the volatile block. Undefined without a plan.
 */
export function renderPinned(state: PlanningState): string | undefined {
  const { plan } = state;
  if (plan.length === 0) return undefined;
  return ['# Plan', PLAN_INSTRUCTIONS, ...plan.flatMap(planLines)].join('\n');
}

/** `## Plan status` and `## Todo` (the todo items with their statuses) for the volatile block. */
export function renderStatusSections(state: PlanningState): VolatileSection[] {
  const { plan, todo } = state;
  const sections: VolatileSection[] = [];
  if (plan.length > 0) sections.push({ title: 'Plan status', body: plan.map(({ id, status }) => `- ${id}: ${status}`).join('\n') });
  if (todo.length > 0) sections.push({ title: 'Todo', body: renderTodoBody(todo) });
  return sections;
}
