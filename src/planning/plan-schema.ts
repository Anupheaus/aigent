import { z } from 'zod';
import { PLAN_STATUSES } from '../streaming/directive-schemas.js';

const MAX_PLAN_ITEMS = 50;
const MAX_ID_LENGTH = 40;
const MAX_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_CRITERIA = 20;
const MAX_CRITERION_LENGTH = 300;

export const planItemSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  label: z.string().min(1).max(MAX_LABEL_LENGTH),
  description: z.string().min(1).max(MAX_DESCRIPTION_LENGTH),
  acceptanceCriteria: z.array(z.string().min(1).max(MAX_CRITERION_LENGTH)).min(1, 'acceptanceCriteria needs 1 to 20 entries').max(MAX_CRITERIA),
}).strict();

/** `TaskInput.plan`: up to 50 items with unique ids. */
export const planSchema = z.array(planItemSchema).max(MAX_PLAN_ITEMS).superRefine((items, context) => {
  const seen = new Set<string>();
  items.forEach(({ id }, index) => {
    if (seen.has(id)) context.addIssue({ code: 'custom', message: `duplicate plan item id '${id}'`, path: [index, 'id'] });
    seen.add(id);
  });
});

/** One consumer-supplied plan item. */
export type PlanItem = z.infer<typeof planItemSchema>;

export type PlanStatus = typeof PLAN_STATUSES[number];

/** A plan item with its current status and the agent's evidence. */
export interface PlanItemState extends PlanItem {
  status: PlanStatus;
  /** Why the item is done (or why it regressed), as the agent reported it. */
  evidence?: string;
}

/** One item of the agent's own todo list. */
export interface TodoItem {
  /** `t1`, `t2`... unless the agent chose one. */
  id: string;
  label: string;
  description?: string;
  status: PlanStatus;
}
