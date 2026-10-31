import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { computeCacheKey } from '../cache/cache-key.js';
import { withFeedbackFields } from '../feedback/with-feedback-fields.js';
import { estimateTokens } from '../telemetry/estimate-tokens.js';
import { defineTool } from '../tools/define-tool.js';
import { createMultiTool } from '../tools/multi-tool.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import { withMemoryField } from './with-memory-field.js';

/** The most the `memory` field may add to one tool's schema, in estimated tokens (4 characters each). */
const MEMORY_FIELD_TOKEN_BUDGET = 120;

const MEMORY_SCHEMA = {
  type: ['array', 'null'],
  description: 'Notes worth remembering in later runs; usually null.',
  maxItems: 3,
  items: {
    type: 'object',
    additionalProperties: false,
    // No `pinned`: only the application may pin a memory, never the model.
    required: ['kind', 'text', 'tags'],
    properties: {
      kind: { type: 'string', enum: ['fact', 'preference', 'lesson', 'procedure'] },
      text: { type: 'string', maxLength: 300 },
      tags: { type: ['array', 'null'], items: { type: 'string' } },
    },
  },
};

/** A representative tool: a few arguments, one optional. */
const searchTool = defineTool({
  name: 'search_files', description: 'Search files by glob and text', args: z.object({ root: z.string(), glob: z.string(), text: z.string().optional(), limit: z.number().optional() }).strict(),
  deterministic: true, cache: true, describeActivity: () => ({ title: 'search' }), run: async args => args.root,
});

describe('withMemoryField', () => {
  it('adds a required, nullable memory field to a strict tool schema (snapshot)', () => {
    expect(withMemoryField({ tool: searchTool, maxPerCall: 3 }).jsonSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['root', 'glob', 'text', 'limit', 'memory'],
      properties: { ...searchTool.jsonSchema.properties as object, memory: MEMORY_SCHEMA },
    });
  });

  it('caps the list at maxPerCall', () => {
    const { jsonSchema } = withMemoryField({ tool: searchTool, maxPerCall: 1 });
    expect((jsonSchema.properties as Record<string, { maxItems: number }>).memory?.maxItems).toBe(1);
  });

  it('adds memory as an optional property of aigent_multi (top level only)', () => {
    const multi = withMemoryField({ tool: createMultiTool({ registry: createToolRegistry([searchTool]), now: () => 0 }), maxPerCall: 3 });
    expect(multi.jsonSchema).toMatchObject({ required: ['calls'], properties: { memory: MEMORY_SCHEMA } });
  });

  it('keeps the zod schema, the cache key and the original tool unchanged', () => {
    const before = structuredClone(searchTool.jsonSchema);
    const wrapped = withMemoryField({ tool: searchTool, maxPerCall: 3 });
    expect(wrapped.argsSchema).toBe(searchTool.argsSchema);
    expect(searchTool.jsonSchema).toEqual(before);
    const args = { root: '.', glob: '*.ts', text: null, limit: null };
    expect(computeCacheKey({ tool: wrapped, args })).toBe(computeCacheKey({ tool: searchTool, args }));
  });

  it('sits beside previous when feedback is on', () => {
    const both = withMemoryField({ tool: withFeedbackFields(searchTool), maxPerCall: 3 });
    expect(both.jsonSchema.required).toEqual(['root', 'glob', 'text', 'limit', 'previous', 'memory']);
  });

  it(`costs at most ${MEMORY_FIELD_TOKEN_BUDGET} estimated tokens per tool schema`, () => {
    const added = estimateTokens(JSON.stringify(withMemoryField({ tool: searchTool, maxPerCall: 3 }).jsonSchema)) - estimateTokens(JSON.stringify(searchTool.jsonSchema));
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThanOrEqual(MEMORY_FIELD_TOKEN_BUDGET);
  });
});
