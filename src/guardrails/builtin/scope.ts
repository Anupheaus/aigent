import type { Guardrail, GuardrailRunContext, ScopeOptions } from '../guardrail-types.js';

/** Keeps planned calls inside the configured tools and the task's scope, and flags forbidden terms in the output. */
export function scopeGuardrails(params: { options: ScopeOptions; run: GuardrailRunContext }): Guardrail[] {
  const { options: { allowTools, denyTools = [], forbiddenTerms = [] }, run: { outOfScope = [] } } = params;
  const denied = new Set(denyTools);
  const outOfScopeTools = new Set(outOfScope);
  const guardrails: Guardrail[] = [{
    name: 'scope', stage: 'toolCall',
    check: value => {
      if (typeof value !== 'object' || !('args' in value)) return { action: 'allow' };
      const { tool } = value;
      const suggestion = 'Use another tool or do without it.';
      if (denied.has(tool)) return { action: 'block', code: 'tool_out_of_scope', reason: `Tool '${tool}' is denied for this agent. ${suggestion}` };
      if (allowTools != null && !allowTools.includes(tool)) return { action: 'block', code: 'tool_out_of_scope', reason: `Tool '${tool}' is not among the allowed tools: ${allowTools.join(', ')}. ${suggestion}` };
      if (outOfScopeTools.has(tool)) return { action: 'block', code: 'tool_out_of_scope', reason: `Tool '${tool}' is out of scope for this task. ${suggestion}` };
      return { action: 'allow' };
    },
  }];
  if (forbiddenTerms.length === 0) return guardrails;
  return [...guardrails, {
    name: 'scope', stage: 'output',
    check: (value, { warn }) => {
      const text = typeof value === 'string' ? value.toLowerCase() : '';
      for (const term of forbiddenTerms) if (text.includes(term.toLowerCase())) warn(`the output mentions the forbidden term '${term}'`);
      return { action: 'allow' };
    },
  }];
}
