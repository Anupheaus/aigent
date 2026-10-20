import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import { defineGuardrail } from './define-guardrail.js';
import type { GuardrailOptions } from './guardrail-types.js';

const piiMode = z.enum(['warn', 'redact', 'off']);
const names = z.array(z.string().min(1));
const off = z.literal(false);

const optionsSchema = z.object({
  builtins: z.object({
    secrets: z.union([off, z.object({ holdBackChars: z.number().int().positive().optional() }).strict()]).optional(),
    pii: z.union([off, z.object({ output: piiMode.optional(), toolResult: piiMode.optional() }).strict()]).optional(),
    injection: z.union([off, z.object({}).strict()]).optional(),
    scope: z.union([off, z.object({ allowTools: names.optional(), denyTools: names.optional(), forbiddenTerms: names.optional() }).strict()]).optional(),
    'loop-guard': z.union([off, z.object({ maxRepeats: z.number().int().positive().optional(), maxOutputChars: z.number().int().positive().optional() }).strict()]).optional(),
    'output-schema': z.union([off, z.object({ retries: z.number().int().nonnegative().optional() }).strict()]).optional(),
  }).strict().optional(),
  custom: z.array(z.unknown()).optional(),
  failMode: z.enum(['closed', 'open']).optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();

/** Validates `createAigent({ guardrails })` (each custom guardrail through `defineGuardrail`); throws `invalid_input`. */
export function parseGuardrailOptions(raw: unknown): GuardrailOptions {
  if (raw === undefined) return {};
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) throw createAigentError({ code: 'invalid_input', message: `Invalid guardrails options: ${describeIssues(parsed.error)}`, details: { issues: parsed.error.issues.length } });
  const { custom = [], ...rest } = raw as GuardrailOptions;
  return { ...rest, custom: custom.map(defineGuardrail) };
}
