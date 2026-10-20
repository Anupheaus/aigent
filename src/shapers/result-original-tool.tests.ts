import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../tools/tool-types.js';
import { createOriginalStore } from './original-store.js';
import { createResultOriginalTool, RESULT_ORIGINAL_TOOL_NAME } from './result-original-tool.js';

const CONTEXT: ToolContext = { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c', signal: new AbortController().signal };

describe('createOriginalStore', () => {
  it('hands out H1, H2... and returns the exact text', () => {
    const originals = createOriginalStore();
    expect(originals.put('first\r\n')).toBe('H1');
    expect(originals.put('second')).toBe('H2');
    expect(originals.get('H1')).toBe('first\r\n');
    expect(originals.get('H3')).toBeUndefined();
    expect(originals.handles()).toEqual(['H1', 'H2']);
  });
});

describe('result_original', () => {
  it('is strict, uncached and returns one envelope per handle with the verbatim original', async () => {
    const originals = createOriginalStore();
    originals.put('\u001b[31mraw\u001b[0m   \n');
    const tool = createResultOriginalTool({ originals });
    expect(tool).toMatchObject({ name: RESULT_ORIGINAL_TOOL_NAME, strict: true, deterministic: false, cache: false });
    expect(tool.maxResultTokens).toBeGreaterThan(0);
    const result = await tool.run({ handles: ['H1', 'H9'] }, CONTEXT);
    expect(result).toEqual([
      { index: 0, ok: true, result: { handle: 'H1', text: '\u001b[31mraw\u001b[0m   \n' } },
      { index: 1, ok: false, error: expect.objectContaining({ code: 'unknown_handle', message: expect.stringContaining('H9'), suggestion: expect.stringContaining('H1') }) },
    ]);
    expect(tool.countItems?.(result)).toEqual({ total: 2, failed: 1 });
  });

  it('accepts 1 to 10 handles', () => {
    const tool = createResultOriginalTool({ originals: createOriginalStore() });
    expect(tool.argsSchema.safeParse({ handles: [] }).success).toBe(false);
    expect(tool.argsSchema.safeParse({ handles: Array.from({ length: 11 }, (_unused, index) => `H${index}`) }).success).toBe(false);
  });
});
