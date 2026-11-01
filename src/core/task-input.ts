import { z } from 'zod';
import { createAigentError } from './aigent-error.js';
import { describeIssues } from './describe-issues.js';
import { planSchema } from '../planning/plan-schema.js';
import { MAX_DELEGATION_DEPTH } from './delegation-types.js';
import { shapersSettingSchema } from '../shapers/shapers-setting.js';
import { modelSettingsSchema } from './model-settings.js';
import type { OnQuestion } from '../chat/task-questions.js';

const limitsSchema = z.object({
  maxTurns: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();

export const taskInputSchema = z.object({
  task: z.string().min(1),
  context: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  references: z.array(z.object({ label: z.string().min(1), content: z.string().optional(), path: z.string().optional() }).strict()).optional(),
  inScope: z.array(z.string()).optional(),
  outOfScope: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  onAmbiguity: z.enum(['ask', 'assume', 'fail']).optional(),
  unattended: z.boolean().optional(),
  /** Scheduler lane; defaults to `background` for unattended tasks and `interactive` otherwise. */
  priority: z.enum(['interactive', 'background']).optional(),
  /** Routed agents only: `quality` always uses the capable model, `cost` prefers the cheap one once it is proven. */
  routingPriority: z.enum(['speed', 'cost', 'quality']).optional(),
  disableTelemetry: z.boolean().optional(),
  label: z.string().optional(),
  scope: z.record(z.string(), z.string()).optional(),
  /** With memory scope `interface`: the consumer's opaque key of the interface the task comes from (else `scope.interface`). */
  memoryScopeKey: z.string().min(1).max(200).optional(),
  limits: limitsSchema.optional(),
  /** Task-level model settings; they win over the agent's, field by field. */
  modelSettings: modelSettingsSchema.optional(),
  /** Overrides the agent's `shapers` for this task. */
  shapers: shapersSettingSchema.optional(),
  /** Consumer-supplied plan (up to 50 items); the agent reports progress with `plan_complete` or `::aigent plan`. */
  plan: planSchema.optional(),
  signal: z.instanceof(AbortSignal).optional(),
  /**
   * Structured output: the final answer must parse (as JSON, or the text itself with `outputFormat: 'text'`) and match
   * this schema; the model is told the schema and gets `outputRetries` turns to fix an answer that does not match.
   */
  output: z.custom<z.ZodType>(value => value instanceof z.ZodType, 'output must be a zod schema').optional(),
  outputFormat: z.enum(['json', 'text']).optional(),
  /**
   * Change nothing: tools with side effects are simulated through their `dryRun` (refused without one), read-only
   * tools run normally, and the result lists the planned effects.
   */
  dryRun: z.boolean().optional(),
  /** A user attached to the task: registers `ask_user`, whose questions this answers (not with `unattended`). */
  onQuestion: z.custom<OnQuestion>(value => typeof value === 'function', 'onQuestion must be a function').optional(),
  /** Set by the `delegate` tool: the run and call this sub-run works for (stored as `RunRecord.parent`). */
  parent: z.object({
    agentName: z.string().min(1), instanceId: z.string().min(1), runId: z.string().min(1), callId: z.string().min(1),
    depth: z.number().int().min(1).max(MAX_DELEGATION_DEPTH),
    ancestors: z.array(z.string().min(1)).max(MAX_DELEGATION_DEPTH).optional(),
  }).strict().optional(),
}).strict();

export type TaskInput = z.infer<typeof taskInputSchema>;
export type TaskLimits = z.infer<typeof limitsSchema>;

export interface ParseAgentLimitsParams {
  agentName: string;
  limits: unknown;
}

/** Validates an agent definition's default limits with the same rules as task limits; throws `invalid_definition`. */
export function parseAgentLimits(params: ParseAgentLimitsParams): TaskLimits | undefined {
  const { agentName, limits } = params;
  if (limits === undefined) return undefined;
  const result = limitsSchema.safeParse(limits);
  if (result.success) return result.data;
  throw createAigentError({
    code: 'invalid_definition',
    message: `Agent '${agentName}' has invalid limits (each must be a positive integer; allowed keys: maxTurns, maxToolCalls, timeoutMs): ${describeIssues(result.error)}`,
    details: { agentName, issues: result.error.issues.length },
  });
}

export function parseTaskInput(raw: unknown): TaskInput {
  const result = taskInputSchema.safeParse(raw);
  if (result.success) return result.data;
  throw createAigentError({ code: 'invalid_input', message: `Invalid task input: ${describeIssues(result.error)}`, details: { issues: result.error.issues.length } });
}
