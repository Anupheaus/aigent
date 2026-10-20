import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineBatchTool, defineTool } from './define-tool.js';
import { toolFailure } from './tool-failure.js';
import type { ToolContext } from './tool-types.js';

const BASE = {
  name: 'read_thing',
  description: 'Reads a thing',
  args: z.object({ id: z.string() }).strict(),
  deterministic: true,
  cache: true,
  describeActivity: () => ({ title: 'Reading' }),
  run: async () => 'ok',
};

const CONTEXT: ToolContext = { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c', signal: new AbortController().signal };

describe('defineTool', () => {
  it('builds a tool with a strict JSON schema and defaults', () => {
    const tool = defineTool(BASE);
    expect(tool.jsonSchema).toMatchObject({ type: 'object', required: ['id'], additionalProperties: false });
    expect(tool.hasSideEffects).toBe(false);
    expect(tool.timeoutMs).toBe(30_000);
  });

  it('requires deterministic, cache and describeActivity to be declared', () => {
    expect(() => defineTool({ ...BASE, deterministic: undefined as unknown as boolean })).toThrow(/deterministic/);
    expect(() => defineTool({ ...BASE, cache: undefined as unknown as boolean })).toThrow(/cache/);
    expect(() => defineTool({ ...BASE, describeActivity: undefined as unknown as typeof BASE.describeActivity })).toThrow(/describeActivity/);
  });

  it('rejects bad names and impossible flag combinations', () => {
    expect(() => defineTool({ ...BASE, name: 'Bad Name' })).toThrow(/name/);
    expect(() => defineTool({ ...BASE, deterministic: false, cache: true })).toThrow(/cacheTtlMs/);
    expect(() => defineTool({ ...BASE, hasSideEffects: true })).toThrow(/side effects/);
    expect(() => defineTool({ ...BASE, deterministic: false, cache: true, cacheTtlMs: 1_000 })).not.toThrow();
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1.5])('rejects timeoutMs %s with invalid_definition naming the value', timeoutMs => {
    expect(() => defineTool({ ...BASE, timeoutMs })).toThrow(expect.objectContaining({
      code: 'invalid_definition',
      message: expect.stringMatching(new RegExp(`read_thing.*timeoutMs must be a positive integer.*got ${String(timeoutMs)}`)),
    }));
  });

  it('marks tools strict by default and still rejects non-strict argument objects', () => {
    expect(defineTool(BASE).strict).toBe(true);
    expect(() => defineTool({ ...BASE, args: z.object({ id: z.string() }) })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringContaining('.strict()') }));
  });

  it('lets a tool opt out of the strict subset explicitly with strictSchema: false', () => {
    const loose = defineTool({ ...BASE, strictSchema: false, args: z.object({ id: z.string(), extra: z.record(z.string(), z.unknown()).optional() }).strict() });
    expect(loose.strict).toBe(false);
    expect(loose.jsonSchema).toMatchObject({ type: 'object', required: ['id'], properties: { extra: { type: 'object', additionalProperties: true } } });
  });

  it('accepts a positive integer timeoutMs', () => {
    expect(defineTool({ ...BASE, timeoutMs: 120_000 }).timeoutMs).toBe(120_000);
  });

  it('keeps the cache fields and records a hash of the argument schema', async () => {
    const tool = defineTool({ ...BASE, version: '2', cacheKey: args => args.id.toLowerCase(), validity: async args => `v-${args.id}` });
    expect(tool.version).toBe('2');
    expect(tool.cacheKey?.({ id: 'ABC' })).toBe('abc');
    await expect(tool.validity?.({ id: 'x' }, CONTEXT)).resolves.toBe('v-x');
    expect(tool.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(defineTool({ ...BASE, args: z.object({ id: z.number() }).strict() }).schemaHash).not.toBe(tool.schemaHash);
  });

  it('keeps contentKind and fidelity, leaving fidelity absent (verbatim) by default', () => {
    expect(defineTool(BASE).fidelity).toBeUndefined();
    expect(defineTool({ ...BASE, contentKind: 'web-page', fidelity: 'lossy-ok' })).toMatchObject({ contentKind: 'web-page', fidelity: 'lossy-ok' });
  });

  it('rejects unknown kinds and fidelities, and lossy-ok without a contentKind', () => {
    expect(() => defineTool({ ...BASE, contentKind: 'html' as 'web-page' })).toThrow(/contentKind must be one of/);
    expect(() => defineTool({ ...BASE, contentKind: 'log', fidelity: 'lossy' as 'lossy-ok' })).toThrow(/fidelity must be one of/);
    expect(() => defineTool({ ...BASE, fidelity: 'lossy-ok' })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringContaining('needs a contentKind') }));
  });

  it('rejects cache fields that cannot work', () => {
    expect(() => defineTool({ ...BASE, version: '' })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringContaining('version') }));
    expect(() => defineTool({ ...BASE, cacheKey: 'id' as unknown as () => unknown })).toThrow(/cacheKey must be a function/);
    expect(() => defineTool({ ...BASE, validity: 1 as unknown as () => Promise<string> })).toThrow(/validity must be a function/);
    expect(() => defineTool({ ...BASE, cache: false, cacheKey: args => args.id })).toThrow(/only apply to cached tools/);
    expect(() => defineTool({ ...BASE, cache: false, validity: async () => 'v' })).toThrow(/only apply to cached tools/);
  });
});

describe('defineBatchTool', () => {
  const BATCH_BASE = {
    name: 'read_things', description: 'Reads things', item: z.object({ id: z.string() }).strict(), maxItems: 3,
    deterministic: true, cache: false, describeActivity: () => ({ title: 'Reading' }), runItem: async () => 1,
  };

  it.each([0, -1, 2.5, Number.NaN])('rejects maxItems %s with invalid_definition naming the value', maxItems => {
    expect(() => defineBatchTool({ ...BATCH_BASE, maxItems })).toThrow(expect.objectContaining({
      code: 'invalid_definition',
      message: expect.stringMatching(new RegExp(`read_things.*maxItems must be a positive integer.*got ${String(maxItems)}`)),
    }));
  });

  it('validates the batch timeoutMs like any tool', () => {
    expect(() => defineBatchTool({ ...BATCH_BASE, timeoutMs: 0 })).toThrow(/timeoutMs must be a positive integer/);
  });

  it('wraps items, returns per-item results and survives item failures', async () => {
    const tool = defineBatchTool({
      name: 'read_things',
      description: 'Reads things',
      item: z.object({ id: z.string() }).strict(),
      maxItems: 3,
      deterministic: true,
      cache: true,
      describeActivity: () => ({ title: 'Reading' }),
      runItem: async item => {
        if (item.id === 'bad') throw toolFailure({ code: 'nope', message: 'cannot read bad', retryable: false });
        return { id: item.id };
      },
    });
    expect(tool.jsonSchema).toMatchObject({ required: ['items'], properties: { items: { type: 'array', minItems: 1, maxItems: 3 } } });
    const result = await tool.run({ items: [{ id: 'a' }, { id: 'bad' }] }, CONTEXT);
    expect(result).toEqual([
      { index: 0, ok: true, result: { id: 'a' } },
      { index: 1, ok: false, error: expect.objectContaining({ code: 'nope', category: 'thrown', retryable: false }) },
    ]);
    expect(tool.summarise?.(result)).toEqual({ success: false, reason: '1 of 2 items failed' });
    expect(tool.nestedFailures?.(result)).toEqual([expect.objectContaining({ code: 'nope', details: { itemIndex: 1 } })]);
    expect(tool.countItems?.(result)).toEqual({ total: 2, failed: 1 });
  });
});
