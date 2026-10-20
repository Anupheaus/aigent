import { describe, expect, it } from 'vitest';
import type { AigentEvent } from '../core/aigent-events.js';
import type { ToolContext } from '../tools/tool-types.js';
import { applyPlanningDirective } from './apply-directives.js';
import { createPlanCompleteTool, PLAN_COMPLETE_TOOL_NAME } from './plan-complete-tool.js';
import { createRunPlanning } from './run-planning.js';
import { createTodoTool, TODO_TOOL_NAME } from './todo-tool.js';

const CONTEXT: ToolContext = { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c', signal: new AbortController().signal };
const PLAN = [{ id: 'p1', label: 'Find', description: 'Find it', acceptanceCriteria: ['found'] }];

function planningWithEvents(params: { hasPlan: boolean; isTodoEnabled?: boolean }) {
  const events: AigentEvent[] = [];
  const planning = createRunPlanning({ ...(params.hasPlan ? { plan: PLAN } : {}), isTodoEnabled: params.isTodoEnabled ?? true, emit: event => { events.push(event); } });
  return { planning, events };
}

describe('plan_complete and todo tools', () => {
  it('are strict, uncached, non-deterministic batch-style tools', () => {
    const { planning } = planningWithEvents({ hasPlan: true });
    for (const tool of [createPlanCompleteTool({ planning }), createTodoTool({ planning })]) {
      expect(tool).toMatchObject({ strict: true, deterministic: false, cache: false });
      expect(tool.countItems).toBeDefined();
    }
    expect(createPlanCompleteTool({ planning }).name).toBe(PLAN_COMPLETE_TOOL_NAME);
    expect(createTodoTool({ planning }).name).toBe(TODO_TOOL_NAME);
  });

  it('return per-entry results and emit an update only when something changed', async () => {
    const { planning, events } = planningWithEvents({ hasPlan: true });
    const tool = createPlanCompleteTool({ planning });
    const result = await tool.run({ updates: [{ id: 'p1', status: 'in_progress' }, { id: 'p1', status: 'in_progress' }] }, CONTEXT);
    expect(result).toEqual([{ index: 0, ok: true, result: { id: 'p1', changed: true } }, { index: 1, ok: true, result: { id: 'p1', changed: false } }]);
    await tool.run({ updates: [{ id: 'p1', status: 'in_progress' }] }, CONTEXT);
    expect(events.map(({ type }) => type)).toEqual(['plan-update']);
    expect(tool.argsSchema.safeParse({ updates: [] }).success).toBe(false);
    expect(createTodoTool({ planning }).argsSchema.safeParse({ ops: Array.from({ length: 51 }, () => ({ op: 'add', label: 'x' })) }).success).toBe(false);
  });
});

describe('applyPlanningDirective', () => {
  it('applies plan and todo directives through the same rules, warning and queueing a correction per rejected entry', () => {
    const { planning, events } = planningWithEvents({ hasPlan: true });
    applyPlanningDirective({ planning, emit: event => { events.push(event); }, directive: { type: 'plan', data: { updates: [{ id: 'p1', status: 'done' }, { id: 'x', status: 'blocked' }] } } });
    expect(events).toEqual([
      { type: 'warning', message: "Directive 'plan' entry 0 was rejected (evidence_required): Marking plan item 'p1' done needs evidence" },
      { type: 'warning', message: "Directive 'plan' entry 1 was rejected (unknown_plan_item): There is no plan item 'x'" },
    ]);
    const corrections = planning.extras().find(({ title }) => title === 'Corrections');
    expect(corrections?.body.split('\n')).toHaveLength(2);
    // Corrections are shown once.
    expect(planning.extras().find(({ title }) => title === 'Corrections')).toBeUndefined();
  });

  it('ignores a plan directive without a plan and a todo directive without the todo tool, with a warning', () => {
    const { planning, events } = planningWithEvents({ hasPlan: false, isTodoEnabled: false });
    const emit = (event: AigentEvent): void => { events.push(event); };
    applyPlanningDirective({ planning, emit, directive: { type: 'plan', data: { updates: [{ id: 'p1', status: 'done', evidence: 'x' }] } } });
    applyPlanningDirective({ planning, emit, directive: { type: 'todo', data: { ops: [{ op: 'add', label: 'x' }] } } });
    applyPlanningDirective({ planning, emit, directive: { type: 'status', data: { text: 'working' } } });
    expect(events.map(event => (event.type === 'warning' ? event.message : event.type))).toEqual([
      "Directive 'plan' ignored: this task has no plan",
      "Directive 'todo' ignored: this agent has no todo list (todo: false)",
    ]);
    expect(planning.state.todo).toEqual([]);
  });
});
