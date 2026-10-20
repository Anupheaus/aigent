import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import type { JsonSchema } from '../providers/provider-types.js';

/** JSON Schema keywords that the strict subset allows; anything else is rejected so what the model sees equals what is validated. */
const ALLOWED_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'default',
  'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minItems', 'maxItems',
]);
const NULL_TYPE = 'null';

function unsupported(pathLabel: string, keyword: string): never {
  throw createAigentError({
    code: 'invalid_definition',
    message: `Tool argument schema at '${pathLabel}' uses unsupported JSON Schema keyword '${keyword}'; the strict subset allows: ${[...ALLOWED_KEYWORDS].join(', ')}`,
    details: { path: pathLabel, keyword },
  });
}

/**
 * Makes an optional property accept null (strict decoding requires every key, so models send null for "absent").
 * Every constraining keyword must admit null, otherwise the schema contradicts itself and the model can never omit it:
 * `type` widens to include 'null', `enum` gains null, and `const` becomes a two-value `enum`.
 */
function makeNullable(node: JsonSchema, pathLabel: string): JsonSchema {
  const { type, enum: enumValues, const: constValue, ...rest } = node;
  const hasConst = 'const' in node;
  if (typeof type !== 'string' && !Array.isArray(enumValues) && !hasConst) return unsupported(pathLabel, 'optional without a simple type');
  const nullable: JsonSchema = { ...rest };
  if (typeof type === 'string') nullable.type = [type, NULL_TYPE];
  if (Array.isArray(enumValues)) nullable.enum = [...enumValues, null];
  else if (hasConst) nullable.enum = [constValue, null];
  return nullable;
}

function strictify(node: JsonSchema, pathLabel: string): JsonSchema {
  for (const keyword of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(keyword)) unsupported(pathLabel, keyword);
  }
  // zod 4 collapses simple unions (e.g. string | number) into a type array instead of anyOf, so reject those as unions too.
  if (Array.isArray(node.type)) unsupported(pathLabel, 'anyOf (union of types)');
  const result: JsonSchema = { ...node };

  if (node.type === 'object') {
    if (node.additionalProperties !== false) {
      throw createAigentError({
        code: 'invalid_definition',
        message: `Tool argument object at '${pathLabel}' must be declared with .strict() so unknown keys are rejected`,
        details: { path: pathLabel },
      });
    }
    const properties = (node.properties ?? {}) as Record<string, JsonSchema>;
    const originallyRequired = new Set((node.required ?? []) as string[]);
    const strictProperties: Record<string, JsonSchema> = {};
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      const strictProperty = strictify(propertySchema, `${pathLabel}.${propertyName}`);
      strictProperties[propertyName] = originallyRequired.has(propertyName) ? strictProperty : makeNullable(strictProperty, `${pathLabel}.${propertyName}`);
    }
    result.properties = strictProperties;
    result.required = Object.keys(strictProperties);
  }

  if (node.type === 'array' && node.items != null) result.items = strictify(node.items as JsonSchema, `${pathLabel}[]`);
  return result;
}

/** Converts a zod object schema into the strict OpenAI-style JSON schema sent to providers. */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const withoutMeta = { ...(z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as JsonSchema) };
  // $schema is conversion metadata, not part of the tool contract.
  delete withoutMeta.$schema;
  if (withoutMeta.type !== 'object') {
    throw createAigentError({ code: 'invalid_definition', message: `Tool argument schema must be a zod object, got JSON type '${String(withoutMeta.type)}'` });
  }
  return strictify(withoutMeta, 'args');
}
