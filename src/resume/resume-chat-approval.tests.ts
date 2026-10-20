import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chatSetup, delay } from '../chat/chat.test-support.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { textTurn, toolTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { CHECKPOINTS_COLLECTION } from './checkpoint-types.js';
import type { Checkpoint } from './checkpoint-types.js';

const RESUME = { resume: { lease: { ttlMs: 60_000 } } };

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500 && !await condition(); attempt += 1) await delay(2);
}

function wipeTool(ran: string[]) {
  return defineTool({
    name: 'wipe', description: 'Wipe a disk', args: z.object({ disk: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true, requiresApproval: true,
    describeActivity: ({ disk }) => ({ title: `Wipe ${disk}` }), run: async ({ disk }) => { ran.push(disk); return `wiped ${disk}`; },
  });
}

/** The pending request recorded in the run's checkpoints, once there is one. */
async function pendingRequest(store: Store): Promise<{ runId: string; requestId: string } | undefined> {
  const checkpoints = await store.list<Checkpoint>(CHECKPOINTS_COLLECTION);
  for (const { value: { state } } of checkpoints) {
    const [request] = state.kind === 'run' ? state.approvals : [];
    if (state.kind === 'run' && request != null) return { runId: state.runId, requestId: request.requestId };
  }
  return undefined;
}

describe('chat approvals across a restart', () => {
  it('closing a chat whose turn waits for approval does not hang, and the decision given after a restart continues the turn', async () => {
    const store = createInMemoryStore();
    const ran: string[] = [];
    const first = chatSetup({ turns: [toolTurn([{ id: 'w1', name: 'wipe', args: { disk: 'd1' } }])], store, runtime: RESUME, agent: { instanceId: 'ops-1', tools: [wipeTool(ran)] } });
    const chat = first.agent.chat({ sessionId: 's-approve' });
    void chat.send('wipe d1');
    await until(async () => (await pendingRequest(store)) != null);
    await first.ai.close();
    const pending = await pendingRequest(store);
    expect(pending).toBeDefined();
    expect(ran).toEqual([]);

    let laterIds = 0;
    const second = chatSetup({ turns: [textTurn('Wiped d1')], store, runtime: { ...RESUME, clock: { now: () => 10_000_000 }, ids: { next: prefix => `${prefix}_later_${(laterIds += 1)}` } }, agent: { instanceId: 'ops-1', tools: [wipeTool(ran)] } });
    const reopened = second.agent.chat({ sessionId: 's-approve' });
    await reopened.ready;
    await second.agent.approve(pending!.requestId, { decision: 'allow_once' });
    await until(() => ran.length === 1 && reopened.conversation().status === 'idle' && reopened.conversation().messages.at(-1)?.state === 'complete');
    await reopened.close();
    await second.ai.close();
    expect(ran).toEqual(['d1']);
    const result = second.provider.requests[0]?.messages.find(({ toolCallId }) => toolCallId === 'w1');
    expect(JSON.parse(result?.text ?? '{}')).toMatchObject({ ok: true, result: 'wiped d1' });
  });
});
