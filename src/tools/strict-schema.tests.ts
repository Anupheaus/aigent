import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toStrictJsonSchema } from './strict-schema.js';

describe('toStrictJsonSchema', () => {
  it('requires every property and forbids extras, making optionals nullable', () => {
    const schema = toStrictJsonSchema(z.object({ path: z.string().min(1).max(500), limit: z.number().int().optional() }).strict());
    expect(schema).toMatchObject({
      type: 'object',
      required: ['path', 'limit'],
      additionalProperties: false,
      properties: { path: { type: 'string', minLength: 1, maxLength: 500 }, limit: { type: ['integer', 'null'] } },
    });
    expect(schema).not.toHaveProperty('$schema');
  });

  it('handles enums, arrays and nested objects', () => {
    const schema = toStrictJsonSchema(z.object({
      mode: z.enum(['a', 'b']).optional(),
      tags: z.array(z.string()).min(1).max(3),
      nested: z.object({ id: z.string() }).strict(),
    }).strict());
    expect(schema).toMatchObject({
      properties: {
        mode: { enum: ['a', 'b', null] },
        tags: { type: 'array', minItems: 1, maxItems: 3 },
        nested: { additionalProperties: false, required: ['id'] },
      },
    });
  });

  it('rejects non-object roots, loose objects and unions with a precise error', () => {
    expect(() => toStrictJsonSchema(z.string())).toThrow(/object/);
    expect(() => toStrictJsonSchema(z.object({ a: z.string() }))).toThrow(/strict/);
    expect(() => toStrictJsonSchema(z.object({ a: z.union([z.string(), z.number()]) }).strict())).toThrow(/anyOf/);
  });
});
