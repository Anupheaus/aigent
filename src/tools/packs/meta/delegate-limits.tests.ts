import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAigent } from '../../../core/create-aigent.js';
import { createInMemoryStore } from '../../../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../../../testing/fake-provider.js';
import type { FakeTurn } from '../../../testing/fake-provider.js';
import { defineTool } from '../../define-tool.js';
import { CONTEXT } from '../fs/fs-tools.test-support.js';
import { metaTools } from './index.js';
import type { MetaToolsOptions } from './index.js';

const delegateTo = (id: string, agent = 'helper') => ({ id, name: 'delegate', args: { agent, task: 'do it', returnBudgetTokens: null } });
const ping = defineTool({ name: 'ping', description: 'ping', args: z.object({}).strict(), deterministic: false, cache: false, describeActivity: () => ({ title: 'ping' }), run: async () => 'pong' });
const hang = defineTool({ name: 'hang', description: 'hang', args: z.object({}).strict(), deterministic: false, cache: false, describeActivity: () => ({ title: 'hang' }), run: (_args, { signal }) => new Promise(resolve => { signal.addEventListener('abort', () => resolve('aborted'), { once: true }); }) });

function setup(params: { turns: FakeTurn[]; lead?: MetaToolsOptions; leadLimits?: { maxToolCalls: number }; helperTargets?: string[]; helperTools?: ReturnType<typeof defineTool>[] }) {
  const { turns, lead = {}, leadLimits, helperTargets = [], helperTools = [] } = params;
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false });
  ai.agent({ name: 'helper', model: 'fake:m', todo: false, tools: [...helperTools, ...metaTools({ delegateTargets: helperTargets })] });
  const leader = ai.agent({ name: 'lead', model: 'fake:m', todo: false, tools: [ping, ...metaTools({ delegateTargets: ['helper'], ...lead })], ...(leadLimits == null ? {} : { limits: leadLimits }) });
  return { ai, leader, provider };
}

const resultOf = (provider: ReturnType<typeof createFakeProvider>, callId: string) => {
  const message = provider.requests.flatMap(({ messages }) => messages).find(({ toolCallId }) => toolCallId === callId);
  return JSON.parse(message?.text ?? '{}');
};

describe('delegate limits (I6)', () => {
  it('refuses a cycle: an agent already up the chain, or the caller itself', async () => {
    const { ai, leader, provider } = setup({ turns: [toolTurn([delegateTo('d1')]), toolTurn([delegateTo('d2', 'lead')]), textTurn('helper done'), textTurn('top')], helperTargets: ['lead'] });
    await leader.task({ task: 'go' });
    expect(resultOf(provider, 'd2')).toMatchObject({ ok: false, error: { category: 'denied', code: 'delegation_cycle' } });
    await ai.close();
    const selfProvider = createFakeProvider({ turns: [toolTurn([delegateTo('s1', 'solo')]), textTurn('done')] });
    const self = createAigent({ providers: [selfProvider], store: createInMemoryStore(), enableFeedback: false });
    const solo = self.agent({ name: 'solo', model: 'fake:m', todo: false, tools: metaTools({ delegateTargets: ['solo'] }) });
    await solo.task({ task: 'go' });
    expect(resultOf(selfProvider, 's1')).toMatchObject({ ok: false, error: { code: 'delegation_cycle' } });
    await self.close();
  });

  it('caps sub-runs in flight per run', async () => {
    const { ai, leader, provider } = setup({ turns: [toolTurn([delegateTo('d1'), delegateTo('d2'), delegateTo('d3')]), textTurn('one'), textTurn('two'), textTurn('top')], lead: { maxConcurrentDelegations: 2 } });
    await leader.task({ task: 'go' });
    expect(['d1', 'd2', 'd3'].map(id => resultOf(provider, id).error?.code ?? 'ok')).toEqual(['ok', 'ok', 'too_many_delegations']);
    await ai.close();
  });

  it('counts a sub-run\'s tool calls against the caller\'s maxToolCalls, and gives it no more than is left', async () => {
    const turns = [toolTurn([delegateTo('d1')]), toolTurn([{ id: 'p1', name: 'ping', args: {} }]), toolTurn([{ id: 'p2', name: 'ping', args: {} }]), toolTurn([{ id: 'p3', name: 'ping', args: {} }]), textTurn('child done'), toolTurn([{ id: 'p4', name: 'ping', args: {} }]), textTurn('top')];
    const { ai, leader, provider } = setup({ turns, leadLimits: { maxToolCalls: 3 }, helperTools: [ping] });
    const result = await leader.task({ task: 'go' });
    // The lead used 1 call (delegate), so the helper got 2: its third ping is over its limit.
    expect(resultOf(provider, 'p3')).toMatchObject({ ok: false, error: { code: 'tool_call_limit' } });
    expect(result.usage.delegated).toMatchObject({ runs: 1, toolCalls: 2 });
    // 1 own + 2 delegated = 3: the lead has nothing left.
    expect(resultOf(provider, 'p4')).toMatchObject({ ok: false, error: { code: 'tool_call_limit' } });
    await ai.close();
  });

  it('refuses to delegate when the caller has no tool calls left to give', async () => {
    const { ai, leader, provider } = setup({ turns: [toolTurn([{ id: 'p1', name: 'ping', args: {} }, delegateTo('d1')]), textTurn('top')], leadLimits: { maxToolCalls: 2 } });
    await leader.task({ task: 'go' });
    expect(resultOf(provider, 'd1')).toMatchObject({ ok: false, error: { code: 'delegation_budget_exhausted' } });
    await ai.close();
  });

  it('stops the sub-run when the delegation times out, and still rolls up its usage', async () => {
    const { ai, leader, provider } = setup({ turns: [toolTurn([delegateTo('d1')]), toolTurn([{ id: 'h1', name: 'hang', args: {} }]), textTurn('top')], lead: { delegateTimeoutMs: 200 }, helperTools: [hang] });
    const started = Date.now();
    const result = await leader.task({ task: 'go' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(resultOf(provider, 'd1')).toMatchObject({ ok: true, result: { status: 'cancelled' } });
    expect(result.usage.delegated).toMatchObject({ runs: 1, toolCalls: 1 });
    await ai.close();
  });

  it('asks for approval before delegating to a target marked requiresApproval, and names few targets in its description', () => {
    const [tool] = metaTools({ delegateTargets: ['reader', { name: 'writer', requiresApproval: true }] });
    const when = (tool?.requiresApproval as { when(args: unknown, context: unknown): boolean }).when;
    expect(when({ agent: 'writer', task: 't' }, CONTEXT)).toBe(true);
    expect(when({ agent: 'reader', task: 't' }, CONTEXT)).toBe(false);
    const [many] = metaTools({ delegateTargets: Array.from({ length: 20 }, (_unused, index) => `agent${index}`) });
    expect(many?.description).toContain('and 12 more');
  });
});
