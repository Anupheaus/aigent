import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import type { JsonSchema } from '../providers/provider-types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmptySchema(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).length === 0;
}

/** Rewrites zod's free-form object output (`propertyNames` string + empty `additionalProperties`) as `additionalProperties: true`. */
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [keyword, entry] of Object.entries(value)) result[keyword] = normalise(entry);
  if (result.type === 'object' && isEmptySchema(result.additionalProperties)) {
    result.additionalProperties = true;
    // JSON object keys are always strings, so this constraint says nothing.
    delete result.propertyNames;
  }
  return result;
}

/**
 * Converts a zod object schema into a JSON schema WITHOUT the strict subset: optionals stay optional and free-form
 * objects (`z.record(z.string(), z.unknown())`) become `{ type: 'object', additionalProperties: true }`.
 * Only for tools that opt out with `strictSchema: false` (built in: `aigent_multi`); providers send these with `strict: false`.
 */
export function toLooseJsonSchema(schema: z.ZodType): JsonSchema {
  const converted = normalise(z.toJSONSchema(schema, { target: 'draft-7', io: 'input' })) as JsonSchema;
  // $schema is conversion metadata, not part of the tool contract.
  delete converted.$schema;
  if (converted.type !== 'object') {
    throw createAigentError({ code: 'invalid_definition', message: `Tool argument schema must be a zod object, got JSON type '${String(converted.type)}'` });
  }
  return converted;
}
