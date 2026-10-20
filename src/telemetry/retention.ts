import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';

/** Retention hints a store may honour; the library only stamps them on records. */
export interface RetentionOptions {
  /** Records get `expiresAt = recordedAt + expiresInMs`. */
  expiresInMs?: number;
}

const retentionSchema = z.object({ expiresInMs: z.number().int().positive().optional() }).strict();

/** Validates `createAigent({ retention })`; throws `invalid_definition` naming the bad field. */
export function parseRetention(retention: unknown): RetentionOptions | undefined {
  if (retention === undefined) return undefined;
  const result = retentionSchema.safeParse(retention);
  if (result.success) return result.data;
  throw createAigentError({ code: 'invalid_definition', message: `Invalid retention option (expiresInMs must be a positive integer number of milliseconds): ${describeIssues(result.error)}` });
}
