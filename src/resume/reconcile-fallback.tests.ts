import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toAnthropicMessagesRequest } from '../providers/anthropic-messages.js';
import type { ProviderEvent, ThinkingBlock } from '../providers/provider-types.js';
import { createFakeProvider, textTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import type { LedgerEntry } from './call-ledger.js';
import { message, runState } from './checkpoint.test-support.js';
import { crashableStore, createInMemoryStore, LEASE_TTL_MS, runtimeOver } from './crash-injection.test-support.js';
import { reconcileInterruptedRound } from './reconcile-calls.js';

const note = defineTool({
  name: 'note', description: 'Note', args: z.object({ text: z.string() }).strict(), deterministic: false, cache: false,
  describeActivity: () => ({ title: 'note' }), run: async ({ text }) => `noted ${text}`,
});

function entry(params: { callId: string; turn: number; status: LedgerEntry['status'] }): LedgerEntry {
  const { callId, turn, status } = params;
  return { callId, tool: 'note', args: { text: callId }, argsHash: 'h', idempotencyKey: `r:${callId}`, turn, status, startedAt: 0, ...(status === 'started' ? {} : { envelope: { id: callId, tool: 'note', ok: true, result: `noted ${callId}` } }) };
}

describe('the ledger fallback (no in-flight response in the checkpoint)', () => {
  it('rebuilds only the request that was in flight, never rounds a compaction summarised away', async () => {
    // Two rounds were committed (and summarised, so their messages are gone); the third request was in flight.
    const state = runState([message(1), message(2)], { totals: { usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, turns: 2, toolCalls: 2, retries: 0, fallbacks: 0, compactionTokens: 0 } });
    const ledger = [entry({ callId: 'old1', turn: 1, status: 'done' }), entry({ callId: 'old2', turn: 2, status: 'started' }), entry({ callId: 'new1', turn: 3, status: 'done' })];
    const round = await reconcileInterruptedRound({ restored: { state, ledger }, registry: createToolRegistry([note]), ids: { runId: 'r', agentName: 'a', instanceId: 'i' }, signal: new AbortController().signal, isUnattended: true, now: () => 0, emit: () => undefined });
    const text = JSON.stringify(round.messages);
    expect(text).toContain('new1');
    expect(text).not.toContain('old1');
    expect(text).not.toContain('old2');
    expect(round.turn).toBe(3);
  });

  it('returns nothing when no ledger entry is newer than the checkpoint', async () => {
    const state = runState([message(1)], { totals: { usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, turns: 2, toolCalls: 1, retries: 0, fallbacks: 0, compactionTokens: 0 } });
    const round = await reconcileInterruptedRound({ restored: { state, ledger: [entry({ callId: 'old2', turn: 2, status: 'started' })] }, registry: createToolRegistry([note]), ids: { runId: 'r', agentName: 'a', instanceId: 'i' }, signal: new AbortController().signal, isUnattended: true, now: () => 0, emit: () => undefined });
    expect(round.messages).toEqual([]);
  });
});

describe('a round rebuilt from the ledger with extended thinking', () => {
  it('keeps the signed thinking that preceded the calls, so the resumed Anthropic request is valid', async () => {
    const thinking: ThinkingBlock = { type: 'thinking', thinking: 'I should note it', signature: 'sig-1' };
    const events: ProviderEvent[] = [
      { type: 'thinking-block', block: thinking },
      { type: 'tool-call', call: { id: 'c1', name: 'crashing_note', args: { text: 'x' } } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } },
      { type: 'done', finishReason: 'tool_calls' },
    ];
    const base = createInMemoryStore();
    const process = crashableStore({ store: base });
    let now = 1_000;
    // The crash lands while the tool runs: before the response's `message` checkpoint, so only the ledger knows the round.
    const crashing = defineTool({
      name: 'crashing_note', description: 'Note', args: z.object({ text: z.string() }).strict(), deterministic: false, cache: false,
      describeActivity: () => ({ title: 'note' }), run: async ({ text }) => { if (!process.isCrashed()) { process.crash(); throw new Error('crash'); } return `noted ${text}`; },
    });
    const definition = { name: 'thinker', model: 'fake:m', tools: [crashing], instanceId: 'think-1', todo: false };
    const aiA = runtimeOver({ store: process.store, provider: createFakeProvider({ turns: [{ events }, textTurn('done')] }), now: () => now });
    await aiA.agent(definition).task({ task: 'note x', unattended: true }).then(() => undefined, () => undefined);
    await aiA.close().catch(() => undefined);
    now += LEASE_TTL_MS + 1;
    const provider = createFakeProvider({ turns: [textTurn('done')] });
    const aiB = runtimeOver({ store: base, provider, now: () => now });
    const agent = aiB.agent(definition);
    await agent.ready;
    await agent.resume();
    await aiB.close();
    const [request] = provider.requests;
    const assistant = request?.messages.find(({ role, toolCalls }) => role === 'assistant' && toolCalls != null);
    expect(assistant?.thinkingBlocks).toEqual([thinking]);
    const body = toAnthropicMessagesRequest({ ...request!, settings: { thinking: { enabled: true, budgetTokens: 1_024 } } } as never, { defaultMaxTokens: 4_096, promptCaching: false });
    const wireAssistant = body.messages.find(({ role }) => role === 'assistant');
    expect(wireAssistant?.content[0]).toEqual({ type: 'thinking', thinking: 'I should note it', signature: 'sig-1' });
  });
});
