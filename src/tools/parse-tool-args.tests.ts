import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseToolArgs } from './parse-tool-args.js';

const SCHEMA = z.object({ path: z.string().min(1), limit: z.number().int().max(10).optional() }).strict();

describe('parseToolArgs', () => {
  it('accepts valid args', () => {
    expect(parseToolArgs(SCHEMA, { path: 'a' })).toEqual({ ok: true, value: { path: 'a' } });
  });

  it('treats null for an optional key as absent', () => {
    expect(parseToolArgs(SCHEMA, { path: 'a', limit: null })).toEqual({ ok: true, value: { path: 'a' } });
  });

  it('rejects null for a required key with a field error', () => {
    const result = parseToolArgs(SCHEMA, { path: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors[0]).toMatchObject({ path: 'path' });
  });

  it('rejects unknown keys and out-of-range values', () => {
    const unknownKey = parseToolArgs(SCHEMA, { path: 'a', extra: 1 });
    expect(unknownKey.ok).toBe(false);
    const tooBig = parseToolArgs(SCHEMA, { path: 'a', limit: 11 });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.fieldErrors[0]).toMatchObject({ path: 'limit' });
  });

  it('rejects non-object input', () => {
    expect(parseToolArgs(SCHEMA, 'nope').ok).toBe(false);
  });

  // Null only means "absent" for keys the schema marks optional; data inside free-form payloads must arrive untouched.
  it('keeps nulls inside a required z.unknown() payload while dropping optional nulls', () => {
    const schema = z.object({ payload: z.unknown(), note: z.string().optional() }).strict();
    const payload = { a: null, list: [null, { b: null }] };
    expect(parseToolArgs(schema, { payload, note: null })).toEqual({ ok: true, value: { payload } });
  });

  it('keeps nulls inside free-form records such as aigent_multi args', () => {
    const schema = z.object({ args: z.record(z.string(), z.unknown()) }).strict();
    expect(parseToolArgs(schema, { args: { depth: null, nested: { x: null } } })).toEqual({ ok: true, value: { args: { depth: null, nested: { x: null } } } });
  });

  it('drops optional nulls in nested objects, optional objects and array elements', () => {
    const schema = z.object({
      filter: z.object({ path: z.string(), depth: z.number().optional() }).strict(),
      extra: z.object({ tag: z.string().optional() }).strict().optional(),
      items: z.array(z.object({ id: z.string(), label: z.string().optional() }).strict()),
    }).strict();
    const raw = { filter: { path: 'src', depth: null }, extra: { tag: null }, items: [{ id: 'a', label: null }, { id: 'b', label: 'B' }] };
    expect(parseToolArgs(schema, raw)).toEqual({ ok: true, value: { filter: { path: 'src' }, extra: {}, items: [{ id: 'a' }, { id: 'b', label: 'B' }] } });
    expect(parseToolArgs(schema, { ...raw, extra: null })).toEqual({ ok: true, value: { filter: { path: 'src' }, items: [{ id: 'a' }, { id: 'b', label: 'B' }] } });
  });

  it('still rejects null for a required nested key', () => {
    const schema = z.object({ filter: z.object({ path: z.string() }).strict() }).strict();
    const result = parseToolArgs(schema, { filter: { path: null } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors[0]).toMatchObject({ path: 'filter.path' });
  });
});
