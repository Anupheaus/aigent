import type { z } from 'zod';

/** One line naming every failing path and why, e.g. `temperature: Too big: expected number to be <=2`. */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}
