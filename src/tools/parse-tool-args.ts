import { z } from 'zod';

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

/** Keys whose schema accepts "absent": these are the ones strict-mode models fill with null. */
function isOptionalKey(schema: z.ZodType): boolean {
  return schema instanceof z.ZodOptional || schema instanceof z.ZodDefault;
}

/** Strips wrappers that do not change the shape of the value, so the object or array schema underneath can be walked. */
function unwrap(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) return unwrap(schema.unwrap() as z.ZodType);
  return schema;
}

/**
 * Strict-mode models send null for optional keys; treat that as absent. Guided by the schema, so only keys the schema
 * marks optional lose their null: required keys keep null (and fail validation), and free-form data (`z.unknown()`,
 * `z.record(...)`) keeps every null it contains.
 */
function dropNullOptionals(schema: z.ZodType, value: unknown): unknown {
  const shapeSchema = unwrap(schema);
  if (shapeSchema instanceof z.ZodArray && Array.isArray(value)) {
    const element = shapeSchema.element as z.ZodType;
    return value.map(entry => dropNullOptionals(element, entry));
  }
  if (!(shapeSchema instanceof z.ZodObject) || !isPlainObject(value)) return value;
  const shape = shapeSchema.shape as Record<string, z.ZodType>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const keySchema = shape[key];
    // Unknown keys pass through untouched so the strict object reports them.
    if (keySchema == null) { cleaned[key] = entry; continue; }
    if (entry === null && isOptionalKey(keySchema)) continue;
    cleaned[key] = dropNullOptionals(keySchema, entry);
  }
  return cleaned;
}

export function parseToolArgs(schema: z.ZodType, raw: unknown): ParsedArgs {
  const result = schema.safeParse(dropNullOptionals(schema, raw));
  if (result.success) return { ok: true, value: result.data };
  const fieldErrors = result.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code, message: issue.message }));
  return { ok: false, fieldErrors };
}
