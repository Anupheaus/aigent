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
});
