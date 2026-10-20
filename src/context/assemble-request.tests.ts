import { describe, expect, it } from 'vitest';
import type { ProviderMessage, ProviderToolSpec } from '../providers/provider-types.js';
import { assembleRequest } from './assemble-request.js';
import { cacheBreakpoints } from './cache-breakpoints.js';
import { createContextMessage } from './context-message.js';
import type { ContextMessage } from './context-message.js';
import type { ContextMessageKind } from './message-flags.js';
import { computePrefixHash } from './prefix-hash.js';

const TOOLS: ProviderToolSpec[] = [{ name: 'echo', description: 'Echo', parameters: {}, strict: true }];
const ROLE_OF: Record<ContextMessageKind, ProviderMessage['role']> = {
  system: 'system', brief: 'user', user: 'user', assistant: 'assistant', tool: 'tool', question: 'assistant', answer: 'user', summary: 'user', pinned: 'user', directive: 'user', stub: 'tool',
};

function stateOf(kinds: ContextMessageKind[]): ContextMessage[] {
  return kinds.map((kind, seq) => createContextMessage({ runId: 'r', seq, kind, createdAt: 0, message: { role: ROLE_OF[kind], text: `${kind} ${seq}` } }));
}

describe('assembleRequest', () => {
  it('sends stored order unchanged before any compaction, then the volatile block last', () => {
    const state = stateOf(['system', 'brief', 'pinned', 'assistant', 'tool', 'answer', 'assistant', 'tool']);
    const { request, prefixLength } = assembleRequest({ state, tools: TOOLS, model: 'm', volatile: '# Current state' });
    expect(request.messages.slice(0, -1).map(({ text }) => text)).toEqual(state.map(({ message }) => message.text));
    expect(request.messages.at(-1)).toEqual({ role: 'user', text: '# Current state', volatile: true });
    expect(prefixLength).toBe(state.length);
    expect(request).toMatchObject({ model: 'm', tools: TOOLS });
    expect(request.settings).toBeUndefined();
  });

  it('keeps the hoisted layout after a compaction: non-compactable, the summary, then compactable', () => {
    const state = stateOf(['system', 'brief', 'answer', 'summary', 'assistant', 'tool', 'assistant', 'tool']);
    const { request } = assembleRequest({ state, tools: TOOLS, model: 'm', settings: { temperature: 0 } });
    expect(request.messages.map(({ text }) => text)).toEqual(state.map(({ message }) => message.text));
    expect(request.settings).toEqual({ temperature: 0 });
    expect(request.cacheBreakpoints).toEqual([0, 2, 3]);
  });

  it('refuses a broken layout: two summaries, or a compactable message before the summary', () => {
    expect(() => assembleRequest({ state: stateOf(['system', 'summary', 'summary']), tools: [], model: 'm' })).toThrow(/one summary/);
    expect(() => assembleRequest({ state: stateOf(['system', 'assistant', 'summary']), tools: [], model: 'm' })).toThrow(/before the summary/);
  });

  it('keeps the prefix byte-identical across turns that only append', () => {
    const first = stateOf(['system', 'brief', 'assistant', 'tool']);
    const second = [...first, ...stateOf(['system', 'brief', 'assistant', 'tool', 'assistant', 'tool']).slice(4)];
    const before = assembleRequest({ state: first, tools: TOOLS, model: 'm', volatile: 'v1' });
    const after = assembleRequest({ state: second, tools: TOOLS, model: 'm', volatile: 'v2' });
    expect(computePrefixHash(after.request.messages.slice(0, before.prefixLength), TOOLS)).toBe(computePrefixHash(before.request.messages.slice(0, before.prefixLength), TOOLS));
  });

  it('keeps pairing metadata on the stored messages it converts', () => {
    const assistant = createContextMessage({ runId: 'r', seq: 0, kind: 'assistant', createdAt: 0, pairId: 'c1', message: { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'echo', args: {} }] } });
    const result = createContextMessage({ runId: 'r', seq: 1, kind: 'tool', createdAt: 0, pairId: 'c1', message: { role: 'tool', toolCallId: 'c1', text: 'ok' } });
    const { request } = assembleRequest({ state: [assistant, result], tools: [], model: 'm' });
    expect(request.messages).toEqual([assistant.message, result.message]);
    expect([assistant.pairId, result.pairId]).toEqual(['c1', 'c1']);
  });
});

describe('cacheBreakpoints', () => {
  it('marks the system end, the non-compactable end and the last stable message before the volatile block', () => {
    expect(cacheBreakpoints({ state: stateOf(['system', 'brief', 'pinned', 'assistant', 'tool']), hasVolatile: true })).toEqual([0, 2, 4]);
  });

  it('adds the summary and leaves the last stable message out without a volatile block', () => {
    expect(cacheBreakpoints({ state: stateOf(['system', 'brief', 'summary', 'assistant', 'tool']), hasVolatile: false })).toEqual([0, 1, 2]);
    expect(cacheBreakpoints({ state: stateOf(['system', 'brief', 'summary', 'assistant', 'tool']), hasVolatile: true })).toEqual([0, 1, 2, 4]);
  });

  it('never repeats an index and is empty for an empty state', () => {
    expect(cacheBreakpoints({ state: stateOf(['system']), hasVolatile: true })).toEqual([0]);
    expect(cacheBreakpoints({ state: [], hasVolatile: true })).toEqual([]);
  });
});
