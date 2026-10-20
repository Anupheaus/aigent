import { z } from 'zod';
import { createAigentError } from './aigent-error.js';

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
  disableTelemetry: z.boolean().optional(),
  label: z.string().optional(),
  scope: z.record(z.string(), z.string()).optional(),
  limits: limitsSchema.optional(),
  signal: z.instanceof(AbortSignal).optional(),
}).strict();

export type TaskInput = z.infer<typeof taskInputSchema>;
export type TaskLimits = z.infer<typeof limitsSchema>;

export function parseTaskInput(raw: unknown): TaskInput {
  const result = taskInputSchema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  throw createAigentError({ code: 'invalid_input', message: `Invalid task input: ${problems}`, details: { issues: result.error.issues.length } });
}
