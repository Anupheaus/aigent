import type { AigentEvent } from '../core/aigent-events.js';
import type { Directive } from '../streaming/directive-parser.js';
import type { ItemResult } from './plan-state.js';
import type { RunPlanning } from './run-planning.js';

export interface ApplyPlanningDirectiveParams {
  planning: RunPlanning;
  directive: Directive;
  emit(event: AigentEvent): void;
}

function reject(params: { planning: RunPlanning; emit(event: AigentEvent): void; warning: string; correction: string }): void {
  const { planning, emit, warning, correction } = params;
  emit({ type: 'warning', message: warning });
  planning.addCorrections([correction]);
}

/** Warns about each rejected entry and queues a one-line correction for the next request's volatile block. */
function reportFailures(params: { planning: RunPlanning; emit(event: AigentEvent): void; kind: 'plan' | 'todo'; results: ItemResult[] }): void {
  const { planning, emit, kind, results } = params;
  results.forEach((result, index) => {
    if (result.ok) return;
    const { error: { code, message, suggestion } } = result;
    const correction = `- ::aigent ${kind} entry ${index} was rejected (${code}): ${message}.${suggestion == null ? '' : ` ${suggestion}`}`;
    reject({ planning, emit, warning: `Directive '${kind}' entry ${index} was rejected (${code}): ${message}`, correction });
  });
}

/**
 * Applies an `::aigent plan` or `::aigent todo` directive through the same state functions as the tools, so the
 * rules and the arrival order are the same. Other directives are ignored here.
 */
export function applyPlanningDirective(params: ApplyPlanningDirectiveParams): void {
  const { planning, directive, emit } = params;
  if (directive.type === 'plan') {
    if (!planning.hasPlan) {
      reject({ planning, emit, warning: "Directive 'plan' ignored: this task has no plan", correction: '- ::aigent plan was ignored: this task has no plan; use the todo list for your own steps.' });
      return;
    }
    reportFailures({ planning, emit, kind: 'plan', results: planning.applyPlan(directive.data.updates) });
    return;
  }
  if (directive.type === 'todo') {
    if (!planning.isTodoEnabled) {
      emit({ type: 'warning', message: "Directive 'todo' ignored: this agent has no todo list (todo: false)" });
      return;
    }
    reportFailures({ planning, emit, kind: 'todo', results: planning.applyTodo(directive.data.ops) });
  }
}
