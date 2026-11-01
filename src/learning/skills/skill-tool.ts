import { z } from 'zod';
import { createAigentError } from '../../core/aigent-error.js';
import { defineTool } from '../../tools/define-tool.js';
import type { ExecutedToolCall } from '../../tools/execute-tool-call.js';
import { addErrorDetails } from '../../tools/tool-error-detail.js';
import type { ToolErrorDetail } from '../../tools/tool-error-detail.js';
import type { ToolEnvelope } from '../../tools/tool-envelope.js';
import type { PlannedEffect } from '../../effects/planned-effects.js';
import type { CapturedEffect } from '../../effects/undo-types.js';
import { readPointer } from '../../telemetry/result-leaves.js';
import type { MultiToolContext, Tool, ToolContext, ToolOutcome } from '../../tools/tool-types.js';
import { bindStepArgs } from './skill-binding.js';
import type { Skill } from './skill-types.js';

/** What a skill call returns: every step's standard envelope, the aggregate outcome, and the last step's result. */
export interface SkillResult {
  skill: string;
  version: number;
  outcome: { success: boolean; completedSteps: number; failedStep?: number };
  steps: ToolEnvelope[];
  /** The last step's result, when it succeeded. */
  result?: unknown;
}

/** Headroom over the slowest step's timeout per step, since steps run one after another. */
const STEP_TIMEOUT_MARGIN_MS = 1_000;
const DEFAULT_STEP_TIMEOUT_MS = 30_000;

function hasDispatcher(context: ToolContext): context is MultiToolContext {
  return typeof (context as Partial<MultiToolContext>).runInnerCall === 'function';
}

/** The zod schema of a skill's parameters: exactly the declared scalars, all required. */
function argsSchemaOf(skill: Skill): z.ZodType<Record<string, unknown>> {
  const properties = (skill.argsSchema.properties ?? {}) as Record<string, { type?: string }>;
  const shape = Object.fromEntries(Object.entries(properties).map(([name, { type }]) => [name, type === 'number' ? z.number() : type === 'boolean' ? z.boolean() : z.string()]));
  return z.object(shape).strict();
}

function notRun(params: { id: string; tool: string; error: ToolErrorDetail }): ToolEnvelope {
  const { id, tool, error } = params;
  return { id, tool, ok: false, error };
}

function asResult(value: unknown): SkillResult | undefined {
  return value !== null && typeof value === 'object' && Array.isArray((value as Partial<SkillResult>).steps) ? value as SkillResult : undefined;
}

/**
 * An active skill as a tool. Its steps run one after another through the run's dispatcher (`runInnerCall`), so each
 * takes the path of any call: guardrails, the tool-call budget, approvals, the ledger, the cache, dry runs and tracing.
 * It never runs a tool itself and cannot exceed what its steps' tools may do; outside a run it refuses.
 */
export function createSkillTool(params: { skill: Skill; tools: Map<string, Tool> }): Tool {
  const { skill, tools } = params;
  const { name, description, version, steps, allowSideEffects = false } = skill;
  const composed = steps.map(({ tool }) => tool);
  const executedByResult = new WeakMap<object, ExecutedToolCall[]>();
  const slowest = Math.max(DEFAULT_STEP_TIMEOUT_MS, ...composed.map(tool => tools.get(tool)?.timeoutMs ?? 0));
  const tool = defineTool({
    name, description, args: argsSchemaOf(skill),
    deterministic: composed.every(step => tools.get(step)?.deterministic === true), cache: false,
    timeoutMs: steps.length * (slowest + STEP_TIMEOUT_MARGIN_MS),
    // An interrupted skill is never re-run on resume: a finished step with side effects would run again.
    resume: 'skip',
    describeActivity: () => ({ title: `Running skill ${name}`, detail: composed.join(' -> ') }),
    run: async (args, context) => {
      if (!hasDispatcher(context)) throw createAigentError({ code: 'invalid_input', message: `Skill '${name}' runs only inside an agent run, where each step goes through the run's checks`, details: { skill: name } });
      const executed: ExecutedToolCall[] = [];
      const envelopes: ToolEnvelope[] = [];
      let failedStep: number | undefined;
      for (const [stepIndex, step] of steps.entries()) {
        const id = `step_${stepIndex + 1}`;
        if (failedStep != null && steps[failedStep]?.onFailure === 'stop') {
          envelopes.push(notRun({ id, tool: step.tool, error: { category: 'denied', code: 'skill_step_skipped', retryable: false, message: `Not run: step ${failedStep + 1} failed` } }));
          continue;
        }
        const bound = bindStepArgs({ args: step.args, params: args, valueAt: (fromStep, path) => { const earlier = envelopes[fromStep]; return earlier?.ok === true ? readPointer(earlier.result, path) : undefined; } });
        if (!bound.ok) {
          envelopes.push(notRun({ id, tool: step.tool, error: { category: 'validation', code: 'skill_binding', retryable: false, message: `Step ${stepIndex + 1}: ${bound.reason}` } }));
          failedStep ??= stepIndex;
          continue;
        }
        const needsApproval = allowSideEffects && tools.get(step.tool)?.hasSideEffects === true;
        const call = await context.runInnerCall({ id, tool: step.tool, args: bound.args, ...(needsApproval ? { approvalReason: `Step ${stepIndex + 1} of learned skill '${name}' changes something` } : {}) });
        executed.push(call);
        envelopes.push(call.envelope);
        if (!call.envelope.ok) failedStep ??= stepIndex;
      }
      const last = envelopes.at(-1);
      const result: SkillResult = {
        skill: name, version, steps: envelopes,
        outcome: { success: failedStep == null, completedSteps: envelopes.filter(({ ok }) => ok).length, ...(failedStep == null ? {} : { failedStep: failedStep + 1 }) },
        ...(last?.ok === true ? { result: last.result } : {}),
      };
      executedByResult.set(result, executed);
      return result;
    },
  });
  const innerOf = (result: unknown): ExecutedToolCall[] => (typeof result === 'object' && result !== null ? executedByResult.get(result) ?? [] : []);
  return {
    ...tool, composedTools: composed,
    summarise: (result): ToolOutcome => {
      const outcome = asResult(result)?.outcome;
      return outcome?.success === true ? { success: true, reason: `${outcome.completedSteps} steps succeeded` } : { success: false, reason: `step ${outcome?.failedStep ?? '?'} failed` };
    },
    nestedFailures: result => (asResult(result)?.steps ?? []).flatMap(envelope => (envelope.ok ? [] : [addErrorDetails(envelope.error, { callId: envelope.id, tool: envelope.tool })])),
    plannedEffects: (result): PlannedEffect[] => innerOf(result).flatMap(call => call.plannedEffects ?? []),
    capturedEffects: (result): CapturedEffect[] => innerOf(result).flatMap(call => call.effects ?? []),
  };
}
