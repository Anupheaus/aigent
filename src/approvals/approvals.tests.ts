import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AigentEvent } from '../core/aigent-events.js';
import { createAigent } from '../core/create-aigent.js';
import type { AigentOptions } from '../core/aigent-types.js';
import { readLatestCheckpoint } from '../resume/checkpoint-reader.js';
import { crashableStore } from '../resume/crash-injection.test-support.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import type { RequiresApproval } from './approval-types.js';
import { APPROVALS_COLLECTION } from './audit-trail.js';

type ApprovalRequestEvent = Extract<AigentEvent, { type: 'approval-request' }>;

function deleteTool(params: { requiresApproval?: RequiresApproval; ran: string[] }) {
  const { requiresApproval = true, ran } = params;
  return defineTool({
    name: 'delete_file', description: 'Delete a file', args: z.object({ path: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true,
    requiresApproval, risk: 'high', describeActivity: ({ path }) => ({ title: `Delete ${path}` }),
    run: async ({ path }) => { ran.push(path); return `deleted ${path}`; },
  });
}

const deleteCall = (id: string, path: string) => ({ id, name: 'delete_file', args: { path } });

function setup(params: { turns: FakeTurn[]; requiresApproval?: RequiresApproval; options?: Partial<AigentOptions>; store?: Store }) {
  const { turns, requiresApproval, options = {}, store = createInMemoryStore() } = params;
  const ran: string[] = [];
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], store, enableFeedback: false, ...options });
  const agent = ai.agent({ name: 'cleaner', model: 'fake:m', tools: [deleteTool({ ran, ...(requiresApproval == null ? {} : { requiresApproval }) })], todo: false });
  return { ai, agent, provider, ran, store };
}

/** Runs the task, deciding each approval request with `decide` as it arrives. */
async function runDeciding(params: { agent: ReturnType<typeof setup>['agent']; task?: { task: string; unattended?: boolean }; decide?(request: ApprovalRequestEvent): void }) {
  const { agent, task = { task: 'Clean up' }, decide } = params;
  const run = agent.task(task);
  const events: AigentEvent[] = [];
  for await (const event of run) {
    events.push(event);
    if (event.type === 'approval-request') decide?.(event);
  }
  return { result: await run, events };
}

describe('approvals', () => {
  it.each<[string, RequiresApproval, boolean]>([
    ['true', true, true],
    ['a predicate that matches', args => (args as { path: string }).path.startsWith('/etc'), true],
    ['a predicate that does not match', args => (args as { path: string }).path.startsWith('/tmp'), false],
    ['a policy with a reason', { reason: 'Deleting is permanent' }, true],
    ['a policy whose when is false', { when: () => false }, false],
  ])('asks when requiresApproval is %s', async (_name, requiresApproval, isAsked) => {
    const { agent, ran } = setup({ turns: [toolTurn([deleteCall('d1', '/etc/x')]), textTurn('done')], requiresApproval });
    const { events } = await runDeciding({ agent, decide: request => { void agent.approve(request.requestId, { decision: 'allow_once' }); } });
    const requests = events.filter(event => event.type === 'approval-request');
    expect(requests).toHaveLength(isAsked ? 1 : 0);
    if (isAsked) expect(requests[0]).toMatchObject({ callId: 'd1', tool: 'delete_file', risk: 'high', activity: { title: 'Delete /etc/x' }, argsSummary: '{"path":"/etc/x"}' });
    expect(ran).toEqual(['/etc/x']);
  });

  it('applies pre-granted rules first, deny beating allow, without asking', async () => {
    const options = { approvals: { allow: [{ tool: 'delete_file' }], deny: [{ tool: 'delete_file', argsMatch: { path: '/etc/hosts' } }] } };
    const { agent, ran, provider } = setup({ turns: [toolTurn([deleteCall('d1', '/tmp/a'), deleteCall('d2', '/etc/hosts')]), textTurn('done')], options });
    const { events } = await runDeciding({ agent });
    expect(events.some(event => event.type === 'approval-request')).toBe(false);
    expect(ran).toEqual(['/tmp/a']);
    // The model sees why the denied call did not run.
    const denied = JSON.parse(provider.requests[1]?.messages.find(({ toolCallId }) => toolCallId === 'd2')?.text ?? '{}');
    expect(denied).toMatchObject({ ok: false, error: { category: 'denied', code: 'approval_denied', retryable: false, suggestion: expect.any(String), details: { by: 'rule' } } });
  });

  it('never waits in an unattended run: refused with a structured approval_denied the agent can see', async () => {
    const { agent, ran, provider } = setup({ turns: [toolTurn([deleteCall('d1', '/tmp/a')]), textTurn('done')] });
    const { result, events } = await runDeciding({ agent, task: { task: 'Clean up', unattended: true } });
    expect(result.status).toBe('completed');
    expect(ran).toEqual([]);
    expect(events.some(event => event.type === 'approval-request')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'approval-decision', decision: 'deny', by: 'policy' }));
    expect(provider.requests[1]?.messages.find(({ toolCallId }) => toolCallId === 'd1')?.text).toContain('"code":"approval_denied"');
  });

  it('allow_once asks again next time; allow_always adds a scoped rule for later calls', async () => {
    const turns = [toolTurn([deleteCall('d1', '/tmp/a')]), toolTurn([deleteCall('d2', '/tmp/a')]), toolTurn([deleteCall('d3', '/tmp/b')]), textTurn('done')];
    const { agent, ran } = setup({ turns });
    const decisions: string[] = [];
    await runDeciding({ agent, decide: request => {
      decisions.push(request.callId);
      const decision = request.callId === 'd2' ? { decision: 'allow_always' as const, scope: { argsMatch: { path: '/tmp/a' } } } : { decision: 'allow_once' as const };
      void agent.approve(request.requestId, decision);
    } });
    expect(decisions).toEqual(['d1', 'd2', 'd3']);
    expect(ran).toEqual(['/tmp/a', '/tmp/a', '/tmp/b']);
    const second = setup({ turns: [toolTurn([deleteCall('d4', '/tmp/a')]), textTurn('done')] });
    // allow_always rules belong to the runtime that granted them.
    const { events } = await runDeciding({ agent: second.agent, decide: request => { void second.agent.approve(request.requestId, { decision: 'deny' }); } });
    expect(events.filter(event => event.type === 'approval-request')).toHaveLength(1);
  });

  it('a stop while waiting refuses the call and cleans up; unknown requests are rejected', async () => {
    const { agent, ran, store } = setup({ turns: [toolTurn([deleteCall('d1', '/tmp/a')]), textTurn('done')] });
    const run = agent.task({ task: 'Clean up' });
    let requestId = '';
    for await (const event of run) if (event.type === 'approval-request') { requestId = event.requestId; run.cancel(); }
    expect((await run).status).toBe('cancelled');
    expect(ran).toEqual([]);
    await expect(agent.approve(requestId, { decision: 'allow_once' })).rejects.toMatchObject({ code: 'invalid_input' });
    const audit = await store.list<{ decision: string; by: string }>(APPROVALS_COLLECTION);
    expect(audit.map(({ value: { decision, by } }) => ({ decision, by }))).toEqual([{ decision: 'aborted', by: 'policy' }]);
  });

  it('keeps an audit record of every decision, by rule, by user and by policy', async () => {
    const options = { approvals: { deny: [{ tool: 'delete_file', argsMatch: { path: '/etc/hosts' } }] } };
    const { agent, store } = setup({ turns: [toolTurn([deleteCall('d1', '/tmp/a'), deleteCall('d2', '/etc/hosts')]), toolTurn([deleteCall('d3', '/tmp/c')]), textTurn('done')], options });
    await runDeciding({ agent, decide: request => { void agent.approve(request.requestId, { decision: request.callId === 'd1' ? 'allow_once' : 'deny', note: `noted ${request.callId}` }); } });
    const audit = (await store.list<{ requestId: string; tool: string; decision: string; by: string; argsHash: string; note?: string }>(APPROVALS_COLLECTION)).map(({ value }) => value);
    expect(audit.map(({ requestId, decision, by, note }) => ({ call: requestId.split('_').at(-1), decision, by, note }))).toEqual(expect.arrayContaining([
      { call: 'd1', decision: 'allow_once', by: 'user', note: 'noted d1' },
      { call: 'd2', decision: 'deny', by: 'rule', note: undefined },
      { call: 'd3', decision: 'deny', by: 'user', note: 'noted d3' },
    ]));
    expect(audit).toHaveLength(3);
    expect(audit.every(({ tool, argsHash }) => tool === 'delete_file' && /^[0-9a-f]{64}$/.test(argsHash))).toBe(true);
  });

  it('resolves several concurrent requests decided out of order', async () => {
    const { agent, ran } = setup({ turns: [toolTurn([deleteCall('d1', 'a'), deleteCall('d2', 'b'), deleteCall('d3', 'c')]), textTurn('done')] });
    const pending: ApprovalRequestEvent[] = [];
    const { result } = await runDeciding({ agent, decide: request => {
      pending.push(request);
      if (pending.length < 3) return;
      void agent.approve(pending[2]!.requestId, { decision: 'allow_once' });
      void agent.approve(pending[0]!.requestId, { decision: 'deny' });
      void agent.approve(pending[1]!.requestId, { decision: 'allow_once' });
    } });
    expect(result.status).toBe('completed');
    expect(ran.sort()).toEqual(['b', 'c']);
  });

  it('property: never deadlocks whatever the order and kind of decisions', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
      fc.func(fc.integer()),
      async (allows, order) => {
        const calls = allows.map((_allow, index) => deleteCall(`d${index}`, `p${index}`));
        const { agent, ran } = setup({ turns: [toolTurn(calls), textTurn('done')] });
        const pending: ApprovalRequestEvent[] = [];
        const { result } = await runDeciding({ agent, decide: request => {
          pending.push(request);
          if (pending.length < calls.length) return;
          const shuffled = [...pending].sort((left, right) => order(left.callId) - order(right.callId));
          for (const { requestId, callId } of shuffled) void agent.approve(requestId, { decision: allows[Number(callId.slice(1))] === true ? 'allow_once' : 'deny' });
        } });
        expect(result.status).toBe('completed');
        expect(ran.sort()).toEqual(allows.flatMap((allow, index) => (allow ? [`p${index}`] : [])).sort());
      },
    ), { numRuns: 25 });
  });

  it('keeps a pending request durable (in the checkpoint, outside compactable history) and resumes with a decision given after a restart', async () => {
    const base = createInMemoryStore();
    const process = crashableStore({ store: base });
    let now = 1_000;
    const ranFirst: string[] = [];
    const first = createAigent({ providers: [createFakeProvider({ turns: [toolTurn([deleteCall('d1', '/tmp/a')])] })], store: process.store, enableFeedback: false, clock: { now: () => now }, resume: { lease: { ttlMs: 1_000 } } });
    const firstAgent = first.agent({ name: 'cleaner', model: 'fake:m', tools: [deleteTool({ ran: ranFirst })], todo: false, instanceId: 'cleaner-1' });
    const run = firstAgent.task({ task: 'Clean up' });
    let requestId = '';
    for await (const event of run) {
      if (event.type !== 'approval-request') continue;
      requestId = event.requestId;
      // Let the request be checkpointed, then the process dies while it waits.
      await new Promise(resolve => setTimeout(resolve, 20));
      process.crash();
      run.cancel();
    }
    await first.close();
    const latest = await readLatestCheckpoint({ store: base, instanceId: 'cleaner-1', streamId: (await run).runId });
    expect(latest?.state.kind === 'run' ? latest.state.approvals.map(({ requestId: id }) => id) : []).toEqual([requestId]);
    expect(latest?.state.kind === 'run' ? latest.state.context.messages.some(({ message: { text } }) => text?.includes(requestId) === true) : true).toBe(false);

    now += 2_000;
    const ranSecond: string[] = [];
    const provider = createFakeProvider({ turns: [textTurn('deleted it')] });
    const second = createAigent({ providers: [provider], store: base, enableFeedback: false, clock: { now: () => now }, resume: { lease: { ttlMs: 1_000 } } });
    const agent = second.agent({ name: 'cleaner', model: 'fake:m', tools: [deleteTool({ ran: ranSecond })], todo: false, instanceId: 'cleaner-1' });
    await agent.ready;
    await agent.approve(requestId, { decision: 'allow_once' });
    const resumed = await agent.resume()!;
    expect(resumed).toMatchObject({ status: 'completed', answer: 'deleted it' });
    expect(ranFirst).toEqual([]);
    expect(ranSecond).toEqual(['/tmp/a']);
    await second.close();
  });
});
