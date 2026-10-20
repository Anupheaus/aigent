import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../tools/define-tool.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import { turnMessages } from './turn-messages.js';

function tool(name: string, compactable?: boolean) {
  return defineTool({
    name, description: name, args: z.object({}).strict(), deterministic: false, cache: false, describeActivity: () => ({ title: name }), run: async () => 1,
    ...(compactable == null ? {} : { compactable }),
  });
}

function executed(id: string, toolName: string): ExecutedToolCall {
  return { envelope: { id, tool: toolName, ok: true, result: 1 }, outcome: { success: true, reason: 'ok' }, durationMs: 1, size: { resultBytes: 1, resultTokens: 1, truncated: false }, nested: [] };
}

const REGISTRY = createToolRegistry([tool('free'), tool('kept', false)]);

describe('turnMessages', () => {
  it('pairs the assistant message and its results by the first call id', () => {
    const messages = turnMessages({ registry: REGISTRY, turn: { visible: 'v', calls: [{ id: 'a', name: 'free', args: {} }, { id: 'b', name: 'free', args: {} }], thinkingBlocks: [] }, executed: [executed('a', 'free'), executed('b', 'free')] });
    expect(messages.map(({ kind, pairId, flags }) => ({ kind, pairId, flags }))).toEqual([
      { kind: 'assistant', pairId: 'a', flags: undefined }, { kind: 'tool', pairId: 'a', flags: undefined }, { kind: 'tool', pairId: 'a', flags: undefined },
    ]);
  });

  it('keeps the call and the non-compactable result verbatim, while a compactable sibling result can still be stubbed', () => {
    const messages = turnMessages({ registry: REGISTRY, turn: { visible: '', calls: [{ id: 'a', name: 'free', args: {} }, { id: 'b', name: 'kept', args: {} }], thinkingBlocks: [] }, executed: [executed('a', 'free'), executed('b', 'kept')] });
    expect(messages.map(({ flags }) => flags)).toEqual([{ compactable: false }, undefined, { compactable: false }]);
  });

  it('stores a final answer without pairing', () => {
    expect(turnMessages({ registry: REGISTRY, turn: { visible: 'done', calls: [], thinkingBlocks: [] }, executed: [] })).toEqual([{ kind: 'assistant', message: { role: 'assistant', text: 'done' } }]);
  });
});
