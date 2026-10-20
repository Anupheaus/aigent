import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import { BUILTIN_SHAPER_NAMES } from './shaper-registry.js';
import type { ShapersSetting } from './shaper-types.js';

/** `shapers` on an agent or task: `'off'`, or `{ allow: [...] }` naming built-in shapers only. */
export const shapersSettingSchema = z.union([
  z.literal('off'),
  z.object({
    allow: z.array(z.string()).superRefine((names, context) => {
      for (const name of names.filter(allowed => !BUILTIN_SHAPER_NAMES.includes(allowed))) {
        context.addIssue({ code: 'custom', message: `unknown shaper '${name}'; expected one of ${BUILTIN_SHAPER_NAMES.join(', ')}` });
      }
    }),
  }).strict(),
]);

/** Validates an agent definition's `shapers`; throws `invalid_definition` naming the problem. */
export function parseAgentShapers(params: { agentName: string; shapers: unknown }): ShapersSetting | undefined {
  const { agentName, shapers } = params;
  if (shapers === undefined) return undefined;
  const result = shapersSettingSchema.safeParse(shapers);
  if (result.success) return result.data;
  throw createAigentError({
    code: 'invalid_definition',
    message: `Agent '${agentName}' has invalid shapers (expected 'off' or { allow: [names] }): ${describeIssues(result.error)}`,
    details: { agentName },
  });
}
