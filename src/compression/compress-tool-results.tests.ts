import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createWriteQueue } from '../store/write-queue.js';
import { defineTool } from '../tools/define-tool.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import type { Tool } from '../tools/tool-types.js';
import { compressToolResults, looksLikeCode } from './compress-tool-results.js';
import { createCompressionCache } from './compression-cache.js';
import { parseCompressionOptions } from './compression-options.js';
import type { CompressionOptions } from './compressor-types.js';
import { fakeCompressor } from './fake-compressor.js';

const PROSE = 'the report says the team met on monday and agreed on the plan for the coming weeks with everyone present '.repeat(5);
const CODE = 'const value = compute();\nexport function compute() { return 1; }\n'.repeat(5);

function tool(name: string, compressible?: boolean | 'allow-code'): Tool {
  return defineTool({ name, description: name, args: z.object({}).strict(), deterministic: false, cache: false, describeActivity: () => ({ title: name }), run: async () => '', ...(compressible == null ? {} : { compressible }) });
}

function call(id: string, toolName: string, result: unknown): ExecutedToolCall {
  return { envelope: { id, tool: toolName, ok: true, result }, outcome: { success: true, reason: 'ok' }, durationMs: 1, size: { resultBytes: 1, resultTokens: 1, truncated: false }, nested: [] };
}

async function compress(params: { executed: ExecutedToolCall[]; options?: Partial<CompressionOptions> }) {
  const { executed, options = {} } = params;
  const kept: string[] = [];
  const registry = createToolRegistry([tool('prose', true), tool('code', 'allow-code'), tool('plain')]);
  const compression = parseCompressionOptions({ agentName: 'a', options: { compressor: fakeCompressor(), minTokens: 10, ...options } })!;
  const result = await compressToolResults({ executed, registry, compression, cache: createCompressionCache({ store: createInMemoryStore(), writeQueue: createWriteQueue() }), now: () => 0, keepOriginal: text => { kept.push(text); return `H${kept.length}`; }, signal: new AbortController().signal });
  return { ...result, kept };
}

describe('compressToolResults', () => {
  it('compresses compressible prose, keeps the original by handle, and leaves other tools, objects and code alone', async () => {
    const { executed, records, kept } = await compress({ executed: [call('a', 'prose', PROSE), call('b', 'plain', PROSE), call('c', 'prose', { text: PROSE }), call('d', 'prose', CODE)] });
    expect(executed[0]?.envelope).toMatchObject({ ok: true, result: expect.stringMatching(/\[compressed from ~\d+ tokens; full original: result_original handle H1\]$/) });
    expect(executed.slice(1).map(({ envelope }) => envelope)).toEqual([call('b', 'plain', PROSE), call('c', 'prose', { text: PROSE }), call('d', 'prose', CODE)].map(({ envelope }) => envelope));
    expect(kept).toEqual([PROSE]);
    expect(records).toEqual([expect.objectContaining({ field: 'toolResult', cacheHit: false })]);
  });

  it('compresses code only with allow-code, and nothing unless applyTo includes toolResults', async () => {
    expect((await compress({ executed: [call('a', 'code', CODE)] })).kept).toEqual([CODE]);
    expect((await compress({ executed: [call('a', 'prose', PROSE)], options: { applyTo: ['history'] } })).kept).toEqual([]);
  });
});

describe('looksLikeCode', () => {
  it.each([
    ['fenced', 'see\n```\nx\n```', true],
    ['json', ' {"a": 1}', true],
    ['diff', 'diff --git a/x b/x\n@@ -1 +1 @@', true],
    ['source', CODE, true],
    ['prose', PROSE, false],
  ])('%s', (_name, text, expected) => {
    expect(looksLikeCode(text)).toBe(expected);
  });
});
