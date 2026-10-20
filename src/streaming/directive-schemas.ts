import { z } from 'zod';

const MAX_ANSWER_LENGTH = 300;
const MAX_STATUS_LENGTH = 200;
const MAX_EVIDENCE_LENGTH = 500;
const MAX_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 1000;
/** Same limit as consumer plan item ids. */
const MAX_ID_LENGTH = 40;
/** Most plan updates or todo ops in one tool call or directive. */
export const MAX_PLANNING_CHANGES = 50;

export const PLAN_STATUSES = ['pending', 'in_progress', 'done', 'blocked'] as const;

export const planUpdateSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  status: z.enum(PLAN_STATUSES),
  evidence: z.string().max(MAX_EVIDENCE_LENGTH).optional(),
}).strict();

export const todoOpSchema = z.object({
  op: z.enum(['add', 'edit', 'delete', 'set_status']),
  id: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  label: z.string().min(1).max(MAX_LABEL_LENGTH).optional(),
  description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
  status: z.enum(PLAN_STATUSES).optional(),
  /** set_status only: why an item goes back from done or blocked (required for that, as for plan items). */
  reason: z.string().max(MAX_EVIDENCE_LENGTH).optional(),
}).strict();

export const DIRECTIVE_SCHEMAS = {
  outcome: z.object({ success: z.boolean(), answer: z.string().max(MAX_ANSWER_LENGTH) }).strict(),
  status: z.object({ text: z.string().min(1).max(MAX_STATUS_LENGTH) }).strict(),
  plan: z.object({ updates: z.array(planUpdateSchema).min(1).max(MAX_PLANNING_CHANGES) }).strict(),
  todo: z.object({ ops: z.array(todoOpSchema).min(1).max(MAX_PLANNING_CHANGES) }).strict(),
} as const;

export type DirectiveType = keyof typeof DIRECTIVE_SCHEMAS;
export type PlanUpdate = z.infer<typeof planUpdateSchema>;
export type TodoOp = z.infer<typeof todoOpSchema>;
