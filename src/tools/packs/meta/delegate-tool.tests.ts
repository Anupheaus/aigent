import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AigentEvent } from '../../../core/aigent-events.js';
import { createAigent } from '../../../core/create-aigent.js';
import { createInMemoryStore } from '../../../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../../../testing/fake-provider.js';
import type { FakeTurn } from '../../../testing/fake-provider.js';
import { defineTool } from '../../define-tool.js';
import { metaTools } from './index.js';

const delegateCall = (id: string, args: Record<string, unknown>) => toolTurn([{ id, name: 'delegate', args: { agent: 'helper', task: 'look it up', returnBudgetTokens: null, ...args } }]);

function setup(params: { turns: FakeTurn[]; targets?: string[]; helperTools?: ReturnType<typeof defineTool>[]; helperTargets?: string[] }) {
  const { turns, targets = ['helper'], helperTools = [], helperTargets } = params;
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false });
  const helper = ai.agent({ name: 'helper', model: 'fake:m', todo: false, tools: [...helperTools, ...(helperTargets == null ? [] : metaTools({ delegateTargets: helperTargets }))] });
  const lead = ai.agent({ name: 'lead', model: 'fake:m', todo: false, tools: metaTools({ delegateTargets: targets }) });
  return { ai, lead, helper, provider };
}

async function run(agent: ReturnType<typeof setup>['lead'], task = 'research') {
  const handle = agent.task({ task });
  const events: AigentEvent[] = [];
  for await (const event of handle) events.push(event);
  return { result: await handle, events, handle };
}

const resultOf = (provider: ReturnType<typeof createFakeProvider>, request: number, callId: string) => JSON.parse(provider.requests[request]?.messages.find(({ toolCallId }) => toolCallId === callId)?.text ?? '{}');

describe('metaTools', () => {
  it('registers delegate only for allowed targets', () => {
    expect(metaTools({})).toEqual([]);
    expect(metaTools({ delegateTargets: [] })).toEqual([]);
    expect(metaTools({ delegateTargets: ['helper'] }).map(({ name }) => name)).toEqual(['delegate']);
  });
});

describe('delegate', () => {
  it('runs the named agent as a linked sub-run and returns its status, answer, usage and errors', async () => {
    const { ai, lead, provider } = setup({ turns: [delegateCall('d1', {}), textTurn('the answer is 42'), textTurn('done')] });
    const { result } = await run(lead);
    const delegated = resultOf(provider, 2, 'd1');
    expect(delegated).toMatchObject({ ok: true, result: { agent: 'helper', status: 'completed', answer: 'the answer is 42', truncated: false, errors: [], usage: { inputTokens: 10, outputTokens: 5, turns: 1 } } });
    expect(result.usage.delegated).toEqual({ runs: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, turns: 1, toolCalls: 0 });
    const child = await ai.trace(delegated.result.runId);
    expect(child?.run.parent).toEqual({ agentName: 'lead', instanceId: lead.instanceId, runId: result.runId, callId: 'd1', depth: 1, ancestors: ['lead'] });
    expect((await ai.trace(result.runId))?.run.usage.delegated).toMatchObject({ runs: 1 });
    await ai.close();
  });

  it('refuses agents that are not allowed or do not exist', async () => {
    const { ai, lead, provider } = setup({ turns: [toolTurn([{ id: 'd1', name: 'delegate', args: { agent: 'stranger', task: 't', returnBudgetTokens: null } }]), textTurn('done')], targets: ['helper', 'stranger'] });
    await run(lead);
    expect(resultOf(provider, 1, 'd1')).toMatchObject({ ok: false, error: { category: 'denied', code: 'unknown_agent' } });
    await ai.close();
    const other = setup({ turns: [toolTurn([{ id: 'd1', name: 'delegate', args: { agent: 'lead', task: 't', returnBudgetTokens: null } }]), textTurn('done')] });
    await run(other.lead);
    expect(resultOf(other.provider, 1, 'd1')).toMatchObject({ ok: false, error: { category: 'denied', code: 'agent_not_allowed' } });
    await other.ai.close();
  });

  // Replaces the earlier depth test, which reached depth 4 by letting 'helper' delegate to itself: that is a cycle,
  // now refused, so the chain is built from distinct agents.
  it('enforces a depth of at most 3 along a chain of distinct agents', async () => {
    const call = (id: string, agent: string) => toolTurn([{ id, name: 'delegate', args: { agent, task: 'go deeper', returnBudgetTokens: null } }]);
    const provider = createFakeProvider({ turns: [call('d1', 'a'), call('d2', 'b'), call('d3', 'c'), call('d4', 'd'), textTurn('c done'), textTurn('b done'), textTurn('a done'), textTurn('top')] });
    const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false });
    const chain = ['lead', 'a', 'b', 'c', 'd'];
    const agents = chain.map((name, index) => ai.agent({ name, model: 'fake:m', todo: false, tools: metaTools({ delegateTargets: index + 1 < chain.length ? [chain[index + 1] as string] : [] }) }));
    await run(agents[0] as ReturnType<typeof setup>['lead']);
    expect(resultOf(provider, 4, 'd4')).toMatchObject({ ok: false, error: { code: 'depth_limit' } });
    await ai.close();
  });

  it('cuts an answer over the return budget, with a marker and the run to read it from', async () => {
    const { ai, lead, provider } = setup({ turns: [delegateCall('d1', { returnBudgetTokens: 10 }), textTurn('word '.repeat(200)), textTurn('done')] });
    await run(lead);
    const delegated = resultOf(provider, 2, 'd1').result;
    expect(delegated).toMatchObject({ truncated: true, fullAnswer: { runId: expect.any(String), chars: 999 } });
    expect(delegated.answer.length).toBeLessThan(200);
    expect(delegated.answer).toContain('[answer cut');
    await ai.close();
  });

  it('propagates an immediate stop to the sub-run', async () => {
    let release: (() => void) | undefined;
    const slow = defineTool({ name: 'slow', description: 'slow', args: z.object({}).strict(), deterministic: false, cache: false, describeActivity: () => ({ title: 'slow' }), run: (_args, { signal }) => new Promise(resolve => { release = () => resolve('late'); signal.addEventListener('abort', () => resolve('aborted'), { once: true }); }) });
    const { ai, lead } = setup({ turns: [delegateCall('d1', {}), toolTurn([{ id: 's1', name: 'slow', args: {} }]), textTurn('child'), textTurn('done')], helperTools: [slow] });
    const handle = lead.task({ task: 'research' });
    const events: AigentEvent[] = [];
    for await (const event of handle) {
      events.push(event);
      if (event.type === 'delegated' && event.event.type === 'tool-call') handle.stop({ mode: 'immediate' });
    }
    expect((await handle).status).toBe('cancelled');
    const childDone = events.find((event): event is Extract<AigentEvent, { type: 'delegated' }> => event.type === 'delegated' && event.event.type === 'done');
    expect(childDone?.event).toMatchObject({ status: 'cancelled' });
    release?.();
    await ai.close();
  });

  it('rolls the sub-run activity into the parent current list', async () => {
    let release: (() => void) | undefined;
    const slow = defineTool({ name: 'slow', description: 'slow', args: z.object({}).strict(), deterministic: false, cache: false, describeActivity: () => ({ title: 'slow' }), run: () => new Promise(resolve => { release = () => resolve('ok'); }) });
    const { ai, lead } = setup({ turns: [delegateCall('d1', {}), toolTurn([{ id: 's1', name: 'slow', args: {} }]), textTurn('child'), textTurn('done')], helperTools: [slow] });
    const handle = lead.task({ task: 'research' });
    let rolled: unknown;
    for await (const event of handle) {
      if (event.type === 'activity' && event.update.current?.some(({ delegatedTo }) => delegatedTo != null) === true) { rolled = event.update.current; release?.(); }
      if (event.type === 'delegated' && event.event.type === 'tool-call') setTimeout(() => release?.(), 2_000);
    }
    await handle;
    expect(rolled).toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'delegate', callId: 'd1' }), expect.objectContaining({ tool: 'slow', callId: 'd1/s1', delegatedTo: { agentName: 'helper', parentCallId: 'd1' } })]));
    await ai.close();
  });
  it('runs the sub-run as a dry run too, and its planned effects become those of the delegate call', async () => {
    const ran: string[] = [];
    const wipe = defineTool({
      name: 'wipe', description: 'wipe', args: z.object({ disk: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true,
      describeActivity: () => ({ title: 'wipe' }), run: async ({ disk }) => { ran.push(disk); return 'wiped'; },
      dryRun: async ({ disk }) => [{ kind: 'disk.wipe', target: disk, summary: `wipe ${disk}`, reversible: false }],
    });
    const { ai, lead } = setup({ turns: [delegateCall('d1', {}), toolTurn([{ id: 'w1', name: 'wipe', args: { disk: 'd0' } }]), textTurn('child done'), textTurn('done')], helperTools: [wipe] });
    const handle = lead.task({ task: 'research', dryRun: true });
    const result = await handle;
    expect(ran).toEqual([]);
    expect(result.plannedEffects).toEqual([expect.objectContaining({ tool: 'delegate', callId: 'd1', kind: 'disk.wipe', target: 'd0', summary: 'helper: wipe d0' })]);
    await ai.close();
  });
});
