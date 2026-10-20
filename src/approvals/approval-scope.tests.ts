import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAigent } from '../core/create-aigent.js';
import type { Agent } from '../core/agent-types.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createWriteQueue } from '../store/write-queue.js';
import { createRecordWriter } from '../telemetry/record-writer.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { createApprovalCenter } from './approval-gate.js';
import type { ApprovalDecision } from './approval-types.js';
import { APPROVALS_COLLECTION, createAuditTrail } from './audit-trail.js';
import { createAllowAlwaysRules } from './allow-always.js';

const deleteTool = defineTool({
  name: 'delete_file', description: 'Delete', args: z.object({ path: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true, requiresApproval: true,
  describeActivity: ({ path }) => ({ title: `Delete ${path}` }), run: async ({ path }) => `deleted ${path}`,
});

const call = (id: string, path: string) => ({ id, name: 'delete_file', args: { path } });

/** A runtime whose provider answers one deletion per task, in order. */
function runtime(paths: string[]) {
  const turns = paths.flatMap((path, index) => [toolTurn([call(`d${index}`, path)]), textTurn('done')]);
  return createAigent({ providers: [createFakeProvider({ turns })], store: createInMemoryStore(), enableFeedback: false });
}

/** Runs one task on `agent`, answering its approval request (if any) with `decision`; returns whether it asked. */
async function runOnce(agent: Agent, decision: ApprovalDecision): Promise<boolean> {
  const run = agent.task({ task: 'clean' });
  let isAsked = false;
  for await (const event of run) {
    if (event.type === 'approval-request') { isAsked = true; void agent.approve(event.requestId, decision); }
  }
  await run;
  return isAsked;
}

describe('allow_always scope', () => {
  it('covers this tool with exactly these arguments by default', async () => {
    const ai = runtime(['/tmp/a', '/tmp/a', '/tmp/b']);
    const agent = ai.agent({ name: 'cleaner', model: 'fake:m', tools: [deleteTool], todo: false });
    expect(await runOnce(agent, { decision: 'allow_always' })).toBe(true);
    expect(await runOnce(agent, { decision: 'deny' })).toBe(false);
    expect(await runOnce(agent, { decision: 'deny' })).toBe(true);
    await ai.close();
  });

  it('stays with the agent instance that granted it unless widened', async () => {
    const ai = runtime(['/tmp/a', '/tmp/a', '/tmp/a']);
    const first = ai.agent({ name: 'cleaner', model: 'fake:m', tools: [deleteTool], todo: false });
    const other = ai.agent({ name: 'cleaner', model: 'fake:m', tools: [deleteTool], todo: false });
    const stranger = ai.agent({ name: 'janitor', model: 'fake:m', tools: [deleteTool], todo: false });
    expect(await runOnce(first, { decision: 'allow_always', scope: { anyArgs: true } })).toBe(true);
    expect(await runOnce(other, { decision: 'deny' })).toBe(true);
    expect(await runOnce(stranger, { decision: 'deny' })).toBe(true);
    await ai.close();
  });

  it('widens to every instance of the agent, or to every agent of the runtime, only when asked', async () => {
    const ai = runtime(['/tmp/a', '/tmp/a', '/tmp/a', '/tmp/a', '/tmp/a']);
    const first = ai.agent({ name: 'cleaner', model: 'fake:m', tools: [deleteTool], todo: false });
    const other = ai.agent({ name: 'cleaner', model: 'fake:m', tools: [deleteTool], todo: false });
    const stranger = ai.agent({ name: 'janitor', model: 'fake:m', tools: [deleteTool], todo: false });
    expect(await runOnce(first, { decision: 'allow_always', scope: { across: 'agent' } })).toBe(true);
    expect(await runOnce(other, { decision: 'deny' })).toBe(false);
    expect(await runOnce(stranger, { decision: 'allow_always', scope: { across: 'runtime' } })).toBe(true);
    expect(await runOnce(stranger, { decision: 'deny' })).toBe(false);
    expect(await runOnce(other, { decision: 'deny' })).toBe(false);
    await ai.close();
  });

  it('rejects a decision whose scope names another tool, and the request stays pending', async () => {
    const ai = runtime(['/tmp/a']);
    const agent = ai.agent({ name: 'cleaner', model: 'fake:m', tools: [deleteTool], todo: false });
    const run = agent.task({ task: 'clean' });
    for await (const event of run) {
      if (event.type !== 'approval-request') continue;
      await expect(agent.approve(event.requestId, { decision: 'allow_always', scope: { tool: '*' } })).rejects.toMatchObject({ code: 'invalid_input' });
      await agent.approve(event.requestId, { decision: 'deny' });
    }
    expect((await run).status).toBe('completed');
    await ai.close();
  });
});

describe('the approval audit trail', () => {
  it('appends a record per decision: an aborted request decided later keeps both', async () => {
    const store = createInMemoryStore();
    const audit = createAuditTrail({ records: createRecordWriter({ store, writeQueue: createWriteQueue() }), clock: { now: () => 1 } });
    const base = { requestId: 'apr_r_c1', runId: 'r', tool: 't', argsHash: 'h', agentName: 'a', instanceId: 'i' };
    await audit.append({ ...base, decision: 'aborted', by: 'policy' });
    await audit.append({ ...base, decision: 'allow_once', by: 'user' });
    const rows = (await store.list<{ decision: string }>(APPROVALS_COLLECTION)).map(({ key, value: { decision } }) => ({ key, decision }));
    expect(rows).toEqual([{ key: 'apr_r_c1:1', decision: 'aborted' }, { key: 'apr_r_c1:2', decision: 'allow_once' }]);
  });
});

describe('a forced re-ask after a restart', () => {
  it('is not approved by a pre-granted allow rule, and deny rules beat an early decision', async () => {
    const audit = createAuditTrail({ clock: { now: () => 1 } });
    const center = createApprovalCenter({ rules: { allow: [{ tool: 'delete_file' }], deny: [{ tool: 'delete_file', argsMatch: { path: '/etc' } }] }, allowAlways: createAllowAlwaysRules(), audit, clock: { now: () => 1 }, agent: { name: 'a', instanceId: 'i' } });
    const gateParams = (path: string, id: string) => ({
      runId: 'r', call: call(id, path), tool: deleteTool, context: { agentName: 'a', instanceId: 'i', runId: 'r', callId: id, signal: new AbortController().signal },
      isUnattended: true, signal: new AbortController().signal, emit: () => undefined,
    });
    expect(await center.gate({ ...gateParams('/tmp/x', 'c1'), force: { reason: 'interrupted' } })).toMatchObject({ isAllowed: false });
    center.restorePending({ runId: 'r', states: [{ requestId: 'apr_r_c2', callId: 'c2', tool: 'delete_file', args: { path: '/etc' }, requestedAt: 0 }] });
    await center.approve('apr_r_c2', { decision: 'allow_once' });
    expect(await center.gate(gateParams('/etc', 'c2'))).toMatchObject({ isAllowed: false, error: { details: { by: 'rule' } } });
  });
});
