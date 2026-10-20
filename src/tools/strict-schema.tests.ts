import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseToolArgs } from './parse-tool-args.js';
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

  // Every keyword that constrains the value must admit null, or strict decoding can never send null for the optional.
  function admitsNull(node: Record<string, unknown>): boolean {
    const { type, enum: enumValues } = node;
    const isTypeOk = type === undefined || (Array.isArray(type) && type.includes('null'));
    const isEnumOk = enumValues === undefined || (Array.isArray(enumValues) && enumValues.includes(null));
    return isTypeOk && isEnumOk && !('const' in node);
  }

  const optionalCases: [string, z.ZodType, Record<string, unknown>][] = [
    ['an optional string enum', z.enum(['a', 'b']).optional(), { type: ['string', 'null'], enum: ['a', 'b', null] }],
    ['an optional string literal', z.literal('x').optional(), { type: ['string', 'null'], enum: ['x', null] }],
    ['an optional number literal', z.literal(3).optional(), { type: ['number', 'null'], enum: [3, null] }],
    ['an optional boolean', z.boolean().optional(), { type: ['boolean', 'null'] }],
  ];

  it.each(optionalCases)('makes %s nullable in every constraining keyword', (_label, field, expected) => {
    const schema = toStrictJsonSchema(z.object({ field }).strict());
    const property = (schema.properties as Record<string, Record<string, unknown>>).field!;
    expect(property).toEqual(expected);
    expect(admitsNull(property)).toBe(true);
    expect(schema.required).toEqual(['field']);
  });

  it('leaves required enums and literals non-nullable', () => {
    const schema = toStrictJsonSchema(z.object({ mode: z.enum(['a', 'b']), kind: z.literal('x') }).strict());
    expect(schema.properties).toEqual({ mode: { type: 'string', enum: ['a', 'b'] }, kind: { type: 'string', const: 'x' } });
  });

  it('accepts null for optional enums and literals and rejects null for required ones (strict-mode arguments)', () => {
    const args = z.object({ mode: z.enum(['a', 'b']).optional(), kind: z.literal('x').optional(), level: z.enum(['low', 'high']) }).strict();
    expect(parseToolArgs(args, { mode: null, kind: null, level: 'low' })).toEqual({ ok: true, value: { level: 'low' } });
    expect(parseToolArgs(args, { mode: 'b', kind: 'x', level: 'high' })).toEqual({ ok: true, value: { mode: 'b', kind: 'x', level: 'high' } });
    const rejected = parseToolArgs(args, { mode: null, kind: null, level: null });
    expect(rejected).toMatchObject({ ok: false, fieldErrors: [{ path: 'level' }] });
  });

  it('rejects non-object roots, loose objects and unions with a precise error', () => {
    expect(() => toStrictJsonSchema(z.string())).toThrow(/object/);
    expect(() => toStrictJsonSchema(z.object({ a: z.string() }))).toThrow(/strict/);
    expect(() => toStrictJsonSchema(z.object({ a: z.union([z.string(), z.number()]) }).strict())).toThrow(/anyOf/);
  });
});
