import { z } from 'zod';
import { todoOpSchema } from '../streaming/directive-schemas.js';
import { BATCH_RESULT_HELPERS } from '../tools/batch-entries.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import { toBatchEntries } from './plan-complete-tool.js';
import type { RunPlanning } from './run-planning.js';

export const TODO_TOOL_NAME = 'todo';
const MAX_OPS = 50;

/** Built-in tool for the agent's own todo list; registered for every agent unless `todo: false`. */
export function createTodoTool(params: { planning: Pick<RunPlanning, 'applyTodo'> }): Tool {
  const { planning } = params;
  const tool = defineTool({
    name: TODO_TOOL_NAME,
    description: 'Keep your own todo list for this task: add (label, optional id and description), edit (id plus label or description), delete (id) or set_status (id, status: pending, in_progress, done or blocked). One result per op; ids are t1, t2... unless you choose one.',
    args: z.object({ ops: z.array(todoOpSchema).min(1).max(MAX_OPS) }).strict(),
    deterministic: false,
    cache: false,
    describeActivity: ({ ops }) => ({ title: `Updating the todo list (${ops.length} changes)`, detail: ops.map(({ op, id }) => (id == null ? op : `${op} ${id}`)).join(', ') }),
    run: async ({ ops }) => toBatchEntries(planning.applyTodo(ops)),
  });
  return { ...tool, ...BATCH_RESULT_HELPERS };
}
