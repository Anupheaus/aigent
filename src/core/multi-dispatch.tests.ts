import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AigentOptions } from './aigent-types.js';
import type { AigentEvent } from './aigent-events.js';
import { createAigent } from './create-aigent.js';
import { CALLS_COLLECTION } from '../resume/checkpoint-types.js';
import type { CallLedgerRecord } from '../resume/call-ledger.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { createMultiTool } from '../tools/multi-tool.js';
import { createToolRegistry } from '../tools/tool-registry.js';

/** What the outside world saw of the `charge` tool: one entry per real run, with the key it was given. */
interface ChargeLog {
  keys: string[];
}

function chargeTool(params: { log: ChargeLog; requiresApproval?: boolean }) {
  const { log, requiresApproval } = params;
  return defineTool({
    name: 'charge', description: 'Charge a card', args: z.object({ amount: z.number() }).strict(), deterministic: false, cache: false, hasSideEffects: true,
    ...(requiresApproval == null ? {} : { requiresApproval }),
    describeActivity: () => ({ title: 'charge' }),
    run: async ({ amount }, { idempotencyKey = '' }) => { log.keys.push(idempotencyKey); return `charged ${amount}`; },
  });
}

const multiCall = (inner: { id: string; amount: number }[]) => ({ id: 'm1', name: 'aigent_multi', args: { calls: inner.map(({ id, amount }) => ({ id, tool: 'charge', args: { amount } })) } });

function setup(params: { requiresApproval?: boolean; options?: Partial<AigentOptions>; calls: { id: string; amount: number }[] }) {
  const { requiresApproval, options = {}, calls } = params;
  const log: ChargeLog = { keys: [] };
  const store = createInMemoryStore();
  const provider = createFakeProvider({ turns: [toolTurn([multiCall(calls)]), textTurn('done')] });
  const ai = createAigent({ providers: [provider], store, enableFeedback: false, ...options });
  const agent = ai.agent({ name: 'pay', model: 'fake:m', tools: [chargeTool({ log, ...(requiresApproval == null ? {} : { requiresApproval }) })], todo: false, instanceId: 'i1' });
  return { ai, agent, log, store, provider };
}

async function collect(run: AsyncIterable<AigentEvent>, onEvent?: (event: AigentEvent) => void): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of run) { events.push(event); onEvent?.(event); }
  return events;
}

describe('aigent_multi inner calls go through the dispatcher', () => {
  it('asks for approval of an inner call whose tool requires it, and runs it only once approved', async () => {
    const { ai, agent, log } = setup({ requiresApproval: true, calls: [{ id: 'a', amount: 5 }] });
    const run = agent.task({ task: 'pay' });
    const events = await collect(run, event => { if (event.type === 'approval-request') void agent.approve(event.requestId, { decision: 'allow_once' }); });
    await run;
    await ai.close();
    expect(events.filter(event => event.type === 'approval-request')).toEqual([expect.objectContaining({ tool: 'charge', callId: 'm1:a' })]);
    expect(log.keys).toHaveLength(1);
  });

  it('refuses an inner call needing approval in an unattended run', async () => {
    const { ai, agent, log, provider } = setup({ requiresApproval: true, calls: [{ id: 'a', amount: 5 }] });
    await agent.task({ task: 'pay', unattended: true });
    await ai.close();
    expect(log.keys).toEqual([]);
    const result = JSON.parse(provider.requests[1]?.messages.find(({ toolCallId }) => toolCallId === 'm1')?.text ?? '{}');
    expect(result).toMatchObject({ ok: true, result: [{ id: 'a', ok: false, error: { code: 'approval_denied' } }] });
  });

  it('applies deny rules to inner calls', async () => {
    const { ai, agent, log } = setup({ requiresApproval: true, calls: [{ id: 'a', amount: 5 }], options: { approvals: { deny: [{ tool: 'charge' }] } } });
    const events = await collect(agent.task({ task: 'pay' }));
    await ai.close();
    expect(log.keys).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'approval-decision', tool: 'charge', decision: 'deny', by: 'rule' }));
  });

  it('gives each inner call its own idempotency key and ledger entry, linked to the wrapper', async () => {
    const { ai, agent, log, store } = setup({ calls: [{ id: 'a', amount: 5 }, { id: 'b', amount: 7 }], options: { resume: { lease: false } } });
    const { runId } = await agent.task({ task: 'pay' });
    await ai.close();
    expect([...log.keys].sort()).toEqual([`${runId}:m1:a`, `${runId}:m1:b`]);
    const ledger = (await store.get<CallLedgerRecord>(CALLS_COLLECTION, runId))?.value.entries ?? [];
    expect(ledger.map(({ callId, parentCallId, status, idempotencyKey }) => ({ callId, parentCallId, status, idempotencyKey }))).toEqual(expect.arrayContaining([
      { callId: 'm1', parentCallId: undefined, status: 'done', idempotencyKey: `${runId}:m1` },
      { callId: 'm1:a', parentCallId: 'm1', status: 'done', idempotencyKey: `${runId}:m1:a` },
      { callId: 'm1:b', parentCallId: 'm1', status: 'done', idempotencyKey: `${runId}:m1:b` },
    ]));
  });

  it('counts inner calls against maxToolCalls and traces each one', async () => {
    const { ai, agent, log } = setup({ calls: [{ id: 'a', amount: 1 }, { id: 'b', amount: 2 }, { id: 'c', amount: 3 }] });
    const result = await agent.task({ task: 'pay', limits: { maxToolCalls: 2 } });
    const trace = await ai.trace(result.runId);
    await ai.close();
    expect(log.keys).toHaveLength(2);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'tool_call_limit' }));
    expect(trace?.steps.filter(step => step.parentCallId === 'm1').map(step => step.callId).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('aigent_multi used directly, without a run', () => {
  it('refuses inner calls to tools that require approval, since nothing can gate them', async () => {
    const log: ChargeLog = { keys: [] };
    const multi = createMultiTool({ registry: createToolRegistry([chargeTool({ log, requiresApproval: true })]), now: () => 0 });
    const result = await multi.run({ calls: [{ id: 'a', tool: 'charge', args: { amount: 1 } }] }, { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'm', signal: new AbortController().signal });
    expect(log.keys).toEqual([]);
    expect(result).toEqual([expect.objectContaining({ id: 'a', ok: false, error: expect.objectContaining({ category: 'denied', code: 'approval_required' }) })]);
  });
});

describe('aigent_multi approvals and the wrapper timeout', () => {
  it('waits for an inner approval longer than the wrapper timeout, and the model sees the real result', async () => {
    const log: ChargeLog = { keys: [] };
    const quickCharge = { ...chargeTool({ log, requiresApproval: true }), timeoutMs: 10 };
    const provider = createFakeProvider({ turns: [toolTurn([multiCall([{ id: 'a', amount: 5 }])]), textTurn('done')] });
    const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false });
    const agent = ai.agent({ name: 'pay', model: 'fake:m', tools: [quickCharge], todo: false });
    const wrapperTimeoutMs = 1_010;
    const run = agent.task({ task: 'pay' });
    await collect(run, event => { if (event.type === 'approval-request') setTimeout(() => { void agent.approve(event.requestId, { decision: 'allow_once' }); }, wrapperTimeoutMs + 100); });
    await run;
    await ai.close();
    expect(log.keys).toHaveLength(1);
    const result = JSON.parse(provider.requests[1]?.messages.find(({ toolCallId }) => toolCallId === 'm1')?.text ?? '{}');
    expect(result).toMatchObject({ ok: true, result: [{ id: 'a', ok: true, result: 'charged 5' }] });
  });

  it('gives inner tools in a run only the public context', async () => {
    let seen: object | undefined;
    const spy = defineTool({ name: 'spy', description: 'spy', args: z.object({}).strict(), deterministic: false, cache: false, describeActivity: () => ({ title: 's' }), run: async (_args, context) => { seen = context; return 1; } });
    const provider = createFakeProvider({ turns: [toolTurn([{ id: 'm1', name: 'aigent_multi', args: { calls: [{ id: 'a', tool: 'spy', args: {} }] } }]), textTurn('done')] });
    const ai = createAigent({ providers: [provider], enableFeedback: false });
    await ai.agent({ name: 'spy', model: 'fake:m', tools: [spy], todo: false }).task({ task: 't' });
    await ai.close();
    expect(seen).toBeDefined();
    expect(Object.keys(seen ?? {}).sort()).toEqual(['agentName', 'callId', 'idempotencyKey', 'instanceId', 'runId', 'signal']);
  });
});
