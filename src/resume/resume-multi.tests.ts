import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolResumePolicy } from '../tools/tool-types.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeProvider } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import { crashableStore, createInMemoryStore, LEASE_TTL_MS, runtimeOver } from './crash-injection.test-support.js';

const INSTANCE = 'multi-1';
const TASK = { task: 'Charge twice and look up the order', unattended: true };

/** What the outside world saw: how often each tool body ran, and the idempotency keys of the effects that happened. */
interface World {
  runs: Map<string, number>;
  effects: Set<string>;
}

interface ToolsParams {
  world: World;
  resume?: ToolResumePolicy;
  /** Crashes the process once the named tool's body has run (after its effect). */
  crashAfter?: string;
  crash?(): void;
}

function tools(params: ToolsParams): Tool[] {
  const { world, resume, crashAfter, crash } = params;
  const ran = (name: string): void => {
    world.runs.set(name, (world.runs.get(name) ?? 0) + 1);
    if (name === crashAfter) { crash?.(); throw new Error('simulated crash after the effect'); }
  };
  const charge = defineTool({
    name: 'charge', description: 'Charge a card', args: z.object({ amount: z.number() }).strict(), deterministic: false, cache: false, hasSideEffects: true,
    ...(resume == null ? {} : { resume }),
    ...(resume === 'verify' ? { verify: async (_args: unknown, { idempotencyKey = '' }) => ({ done: world.effects.has(idempotencyKey), result: 'charged (verified)' }) } : {}),
    describeActivity: () => ({ title: 'charge' }),
    run: async ({ amount }, { idempotencyKey = '' }) => { world.effects.add(idempotencyKey); ran('charge'); return `charged ${amount}`; },
  });
  const lookup = defineTool({
    name: 'lookup', description: 'Look up an order', args: z.object({ id: z.string() }).strict(), deterministic: false, cache: false,
    describeActivity: () => ({ title: 'lookup' }), run: async ({ id }) => { ran('lookup'); return `order ${id}`; },
  });
  return [charge, lookup];
}

const MULTI = { id: 'm1', name: 'aigent_multi', args: { calls: [{ id: 'a', tool: 'charge', args: { amount: 5 } }, { id: 'b', tool: 'lookup', args: { id: 'o1' } }] } };

/** Crashes the first process inside `aigent_multi` after `crashAfter` ran, then resumes the run in a second one. */
async function crashInsideMulti(params: { resume?: ToolResumePolicy; crashAfter: string }) {
  const base = createInMemoryStore();
  const process = crashableStore({ store: base });
  let now = 1_000;
  const world: World = { runs: new Map(), effects: new Set() };
  const aiA = runtimeOver({ store: process.store, provider: createFakeProvider({ turns: [toolTurn([MULTI]), textTurn('done')] }), now: () => now });
  const definition = (toolList: Tool[]) => ({ name: 'pay', model: 'fake:m', tools: toolList, instanceId: INSTANCE, todo: false });
  await aiA.agent(definition(tools({ ...params, world, crash: () => process.crash() }))).task(TASK).then(() => undefined, () => undefined);
  await aiA.close().catch(() => undefined);
  now += LEASE_TTL_MS + 1;
  const provider: FakeProvider = createFakeProvider({ turns: [textTurn('done')] });
  const aiB = runtimeOver({ store: base, provider, now: () => now });
  const agent = aiB.agent(definition(tools({ ...params.resume == null ? {} : { resume: params.resume }, world })));
  await agent.ready;
  const run = agent.resume();
  const result = await run;
  await aiB.close();
  const multiResult = JSON.parse(provider.requests[0]?.messages.find(({ toolCallId }) => toolCallId === 'm1')?.text ?? '{}');
  return { result, world, multiResult };
}

describe('resuming a run interrupted inside aigent_multi', () => {
  it('never runs a finished side effect again: the default ask policy refuses the inner charge when unattended', async () => {
    const { result, world, multiResult } = await crashInsideMulti({ crashAfter: 'charge' });
    expect(result?.status).toBe('completed');
    expect(world.runs.get('charge')).toBe(1);
    expect(multiResult).toMatchObject({ ok: true, result: [{ id: 'a', ok: false, error: { code: 'approval_denied' } }, { id: 'b', ok: true }] });
  });

  it('settles each inner call by its own policy: verify finds the charge done, the read-only lookup is re-run', async () => {
    const { world, multiResult } = await crashInsideMulti({ resume: 'verify', crashAfter: 'lookup' });
    expect(world.runs.get('charge')).toBe(1);
    expect(multiResult).toMatchObject({ ok: true, result: [{ id: 'a', ok: true }, { id: 'b', ok: true, result: 'order o1' }] });
  });

  it('skips an inner call whose tool says skip', async () => {
    const { world, multiResult } = await crashInsideMulti({ resume: 'skip', crashAfter: 'charge' });
    expect(world.runs.get('charge')).toBe(1);
    expect(multiResult).toMatchObject({ result: [{ id: 'a', ok: false, error: { code: 'skipped' } }, { id: 'b', ok: true }] });
  });
});
