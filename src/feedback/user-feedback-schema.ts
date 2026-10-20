import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import { USER_RATINGS } from './feedback-records.js';
import type { UserFeedback } from './feedback-records.js';

const MAX_COMMENT_LENGTH = 2_000;
const MAX_EXPECTED_ANSWER_LENGTH = 10_000;

const userFeedbackSchema = z.object({
  responseId: z.string().min(1),
  rating: z.enum(USER_RATINGS),
  comment: z.string().max(MAX_COMMENT_LENGTH).optional(),
  expectedAnswer: z.string().max(MAX_EXPECTED_ANSWER_LENGTH).optional(),
}).strict();

/** Validates `ai.feedback` input; throws `invalid_input` naming every failing field. */
export function parseUserFeedback(raw: unknown): UserFeedback {
  const result = userFeedbackSchema.safeParse(raw);
  if (result.success) return result.data;
  throw createAigentError({ code: 'invalid_input', message: `Invalid feedback: ${describeIssues(result.error)}`, details: { issues: result.error.issues.length } });
}
