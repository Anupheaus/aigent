import type { JsonSchema } from '../providers/provider-types.js';
import type { Tool } from '../tools/tool-types.js';
import { PREVIOUS_FIELD } from './previous-outcome.js';

/** Longest `previous.answer`, matching the `outcome` directive. */
const MAX_PREVIOUS_ANSWER_LENGTH = 300;

/** Nullable so strict decoding can send null on a run's first call, where there is nothing to report. */
const PREVIOUS_JSON_SCHEMA: JsonSchema = {
  type: ['object', 'null'],
  description: 'How your previous tool step went; null on your first tool call.',
  additionalProperties: false,
  required: ['success', 'answer'],
  properties: {
    success: { type: 'boolean', description: 'true when it found what you were looking for' },
    answer: { type: 'string', maxLength: MAX_PREVIOUS_ANSWER_LENGTH, description: 'short result of that step' },
  },
};

/**
 * The same tool with `previous` added to the JSON schema the model sees: listed as required in the strict subset
 * (strict decoding requires every key) and optional otherwise. The zod schema is unchanged because the loop strips
 * `previous` before the arguments are validated, run, cached or recorded.
 */
export function withFeedbackFields(tool: Tool): Tool {
  const { jsonSchema, strict } = tool;
  const properties = (jsonSchema.properties ?? {}) as Record<string, JsonSchema>;
  const required = (jsonSchema.required ?? []) as string[];
  return {
    ...tool,
    jsonSchema: {
      ...jsonSchema,
      properties: { ...properties, [PREVIOUS_FIELD]: PREVIOUS_JSON_SCHEMA },
      ...(strict ? { required: [...required, PREVIOUS_FIELD] } : {}),
    },
  };
}
