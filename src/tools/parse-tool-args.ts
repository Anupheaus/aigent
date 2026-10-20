import type { z } from 'zod';

export interface FieldError {
  /** Dotted path to the offending argument; empty for the root. */
  path: string;
  code: string;
  message: string;
}

export type ParsedArgs = { ok: true; value: unknown } | { ok: false; fieldErrors: FieldError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict-mode models send null for optional keys; treat that as absent. Required keys keep null so they fail validation. */
function dropNullProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNullProperties);
  if (!isPlainObject(value)) return value;
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null) cleaned[key] = dropNullProperties(entry);
  }
  return cleaned;
}

export function parseToolArgs(schema: z.ZodType, raw: unknown): ParsedArgs {
  const result = schema.safeParse(dropNullProperties(raw));
  if (result.success) return { ok: true, value: result.data };
  const fieldErrors = result.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code, message: issue.message }));
  return { ok: false, fieldErrors };
}
