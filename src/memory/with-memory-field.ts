import { hashSchema } from '../cache/cache-key.js';
import type { JsonSchema } from '../providers/provider-types.js';
import type { Tool } from '../tools/tool-types.js';
import { MAX_MEMORY_TEXT_LENGTH, MEMORY_FIELD } from './memory-schema.js';
import { MEMORY_KINDS } from './memory-types.js';

/**
 * Kept short on purpose: it is repeated in every tool's schema (about 113 estimated tokens), so the tag limits are
 * left to validation and the system prompt. Nullable lists and optionals, because strict decoding requires every key.
 */
function memoryFieldSchema(maxPerCall: number): JsonSchema {
  return {
    type: ['array', 'null'],
    description: 'Notes worth remembering in later runs; usually null.',
    maxItems: maxPerCall,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'text', 'tags', 'pinned'],
      properties: {
        kind: { type: 'string', enum: [...MEMORY_KINDS] },
        text: { type: 'string', maxLength: MAX_MEMORY_TEXT_LENGTH },
        tags: { type: ['array', 'null'], items: { type: 'string' } },
        pinned: { type: ['boolean', 'null'] },
      },
    },
  };
}

export interface WithMemoryFieldParams {
  tool: Tool;
  maxPerCall: number;
}

/**
 * The same tool with `memory` added to the JSON schema the model sees: required (nullable) in the strict subset,
 * optional otherwise. The zod schema and the schema hash stay the tool's own, because the loop takes `memory` out of
 * the arguments before they are validated, run, cached or recorded.
 */
export function withMemoryField(params: WithMemoryFieldParams): Tool {
  const { tool, maxPerCall } = params;
  const { jsonSchema, strict } = tool;
  const properties = (jsonSchema.properties ?? {}) as Record<string, JsonSchema>;
  const required = (jsonSchema.required ?? []) as string[];
  return {
    ...tool,
    schemaHash: tool.schemaHash ?? hashSchema(jsonSchema),
    jsonSchema: {
      ...jsonSchema,
      properties: { ...properties, [MEMORY_FIELD]: memoryFieldSchema(maxPerCall) },
      ...(strict ? { required: [...required, MEMORY_FIELD] } : {}),
    },
  };
}
