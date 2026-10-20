import { describe, expect, it } from 'vitest';
import { resolveContextBudget } from './context-budget.js';
import { createContextMessage, replaceMessageContent, toProviderMessages } from './context-message.js';
import { calibrate, estimateMessageTokens, estimatePromptTokens, MESSAGE_OVERHEAD_TOKENS } from './estimate-prompt-tokens.js';
import { CONTEXT_MESSAGE_KINDS, defaultFlags, pinFlags } from './message-flags.js';

describe('defaultFlags', () => {
  it.each([
    ['system', false], ['brief', false], ['question', false], ['answer', false], ['summary', false], ['pinned', false], ['directive', false],
    ['user', true], ['assistant', true], ['tool', true], ['stub', true],
  ] as const)('%s is compactable: %s', (kind, compactable) => {
    expect(defaultFlags(kind)).toEqual({ compactable, pinned: kind === 'pinned' });
  });

  it('covers every kind, and a pin is never compactable', () => {
    expect(CONTEXT_MESSAGE_KINDS).toHaveLength(11);
    expect(pinFlags()).toEqual({ compactable: false, pinned: true });
  });
});

describe('createContextMessage', () => {
  it('derives the id from the run and seq, applies flag overrides and estimates tokens', () => {
    const message = createContextMessage({ runId: 'run-1', seq: 3, kind: 'tool', createdAt: 5, pairId: 'c1', message: { role: 'tool', toolCallId: 'c1', text: 'x'.repeat(40) } });
    expect(message).toEqual({ id: 'run-1:m3', seq: 3, kind: 'tool', compactable: true, pinned: false, tokens: 10 + MESSAGE_OVERHEAD_TOKENS, createdAt: 5, pairId: 'c1', message: { role: 'tool', toolCallId: 'c1', text: 'x'.repeat(40) } });
    expect(createContextMessage({ runId: 'r', seq: 0, kind: 'tool', createdAt: 0, flags: { compactable: false }, message: { role: 'tool' } }).compactable).toBe(false);
    // A user pin wins over a compactable kind.
    expect(createContextMessage({ runId: 'r', seq: 0, kind: 'user', createdAt: 0, flags: { pinned: true }, message: { role: 'user', text: 'keep' } })).toMatchObject({ compactable: false, pinned: true });
  });

  it('re-estimates replaced content and converts to provider messages in order', () => {
    const original = createContextMessage({ runId: 'r', seq: 0, kind: 'tool', createdAt: 0, message: { role: 'tool', text: 'x'.repeat(400) } });
    const stubbed = replaceMessageContent({ context: original, message: { role: 'tool', text: 'short' } });
    expect(stubbed.tokens).toBeLessThan(original.tokens);
    expect(stubbed.id).toBe(original.id);
    expect(toProviderMessages([original, stubbed])).toEqual([original.message, stubbed.message]);
  });
});

describe('estimatePromptTokens', () => {
  it('grows monotonically with content and counts tool calls and tool specs', () => {
    const small = estimatePromptTokens({ messages: [{ role: 'user', text: 'abc' }], tools: [] });
    const large = estimatePromptTokens({ messages: [{ role: 'user', text: 'abc'.repeat(100) }], tools: [] });
    expect(large).toBeGreaterThan(small);
    expect(estimateMessageTokens({ role: 'assistant', toolCalls: [{ id: 'c', name: 'n', args: { a: 1 } }] })).toBeGreaterThan(MESSAGE_OVERHEAD_TOKENS);
    expect(estimatePromptTokens({ messages: [], tools: [{ name: 't', description: 'd', parameters: {}, strict: true }] })).toBeGreaterThan(0);
  });
});

describe('calibrate', () => {
  it('is the reported/estimated ratio, clamped to 0.5..2, and 1 without data', () => {
    expect(calibrate({ estimated: 100, reported: 120 })).toBe(1.2);
    expect(calibrate({ estimated: 100, reported: 10 })).toBe(0.5);
    expect(calibrate({ estimated: 100, reported: 1_000 })).toBe(2);
    expect(calibrate({ estimated: 0, reported: 10 })).toBe(1);
    expect(calibrate({ estimated: 100, reported: 0 })).toBe(1);
  });
});

describe('resolveContextBudget', () => {
  it('uses contextSize, else the provider window, less the output reserve', () => {
    expect(resolveContextBudget({ maxContextTokens: 128_000 })).toEqual({ contextSize: 128_000, usable: 128_000 - 4096 });
    expect(resolveContextBudget({ contextSize: 10_000, maxContextTokens: 128_000, maxOutputTokens: 1_000 })).toEqual({ contextSize: 10_000, usable: 9_000 });
    expect(resolveContextBudget({ contextSize: 100, maxContextTokens: 128_000, maxOutputTokens: 200 }).usable).toBe(0);
  });

  it('caps the default reserve at a quarter of a small window', () => {
    expect(resolveContextBudget({ maxContextTokens: 1_000 })).toEqual({ contextSize: 1_000, usable: 750 });
    expect(resolveContextBudget({ contextSize: 16_384, maxContextTokens: 128_000 }).usable).toBe(16_384 - 4096);
  });
});
