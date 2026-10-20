import { z } from 'zod';
import { createAigentError } from './aigent-error.js';
import { describeIssues } from './describe-issues.js';
import { modelSettingsSchema } from './model-settings.js';

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
  disableTelemetry: z.boolean().optional(),
  label: z.string().optional(),
  scope: z.record(z.string(), z.string()).optional(),
  limits: limitsSchema.optional(),
  /** Task-level model settings; they win over the agent's, field by field. */
  modelSettings: modelSettingsSchema.optional(),
  signal: z.instanceof(AbortSignal).optional(),
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
