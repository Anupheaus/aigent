import { z } from 'zod';
import { createAigentError } from './aigent-error.js';
import { describeIssues } from './describe-issues.js';
import type { ActivityOptions } from './activity.js';

const activityOptionsSchema = z.object({
  throttleMs: z.number().int().nonnegative().optional(),
  heartbeatMs: z.number().int().positive().optional(),
}).strict();

/** Validates `createAigent({ activity })`; throws `invalid_definition` naming each bad field. */
export function parseActivityOptions(options: unknown): ActivityOptions | undefined {
  if (options === undefined) return undefined;
  const result = activityOptionsSchema.safeParse(options);
  if (result.success) return result.data;
  throw createAigentError({ code: 'invalid_definition', message: `Invalid activity options (throttleMs a non-negative and heartbeatMs a positive integer of ms): ${describeIssues(result.error)}` });
}
