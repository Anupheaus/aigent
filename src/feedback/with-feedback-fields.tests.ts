import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../tools/define-tool.js';
import { createMultiTool } from '../tools/multi-tool.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import { withFeedbackFields } from './with-feedback-fields.js';

const PREVIOUS_SCHEMA = {
  type: ['object', 'null'],
  description: 'How your previous tool step went; null on your first tool call.',
  additionalProperties: false,
  required: ['success', 'answer'],
  properties: {
    success: { type: 'boolean', description: 'true when it found what you were looking for' },
    answer: { type: 'string', maxLength: 300, description: 'short result of that step' },
  },
};

const readTool = defineTool({
  name: 'read', description: 'Read a file', args: z.object({ path: z.string(), limit: z.number().optional() }).strict(),
  deterministic: true, cache: false, describeActivity: () => ({ title: 'read' }), run: async args => args.path,
});

describe('withFeedbackFields', () => {
  it('adds a required, nullable previous field to a strict tool schema (snapshot)', () => {
    const wrapped = withFeedbackFields(readTool);
    expect(wrapped.jsonSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['path', 'limit', 'previous'],
      properties: {
        path: { type: 'string' },
        limit: { type: ['number', 'null'] },
        previous: PREVIOUS_SCHEMA,
      },
    });
  });

  it('adds previous as an optional property of a non-strict tool', () => {
    const multi = withFeedbackFields(createMultiTool({ registry: createToolRegistry([readTool]), now: () => 0 }));
    expect(multi.jsonSchema).toMatchObject({ required: ['calls'], properties: { previous: PREVIOUS_SCHEMA } });
  });

  it('changes nothing else: the zod schema still rejects previous, and the original tool is untouched', () => {
    const before = structuredClone(readTool.jsonSchema);
    const wrapped = withFeedbackFields(readTool);
    expect(wrapped.argsSchema).toBe(readTool.argsSchema);
    expect(wrapped.argsSchema.safeParse({ path: 'a', previous: null }).success).toBe(false);
    expect(readTool.jsonSchema).toEqual(before);
    expect({ ...wrapped, jsonSchema: readTool.jsonSchema }).toEqual(readTool);
  });
});
