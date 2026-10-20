import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AigentEvent } from '../core/aigent-events.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import { readLatestCheckpoint } from './checkpoint-reader.js';
import { LEASES_COLLECTION } from './checkpoint-types.js';
import {
  crashableStore, createInMemoryStore, createWorld, definitionFor, INSTANCE_ID, LEASE_TTL_MS, runtimeOver, SCRIPT_ANSWER, scriptedProvider, worldTools,
} from './crash-injection.test-support.js';
import type { LeaseRecord } from './lease.js';

const TASK = { task: 'Save two notes and read a.txt', unattended: true };

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/** `save_note` with a given resume policy and no verify; it crashes the process after its first effect. */
function policyNote(params: { resume?: 'skip' | 'ask'; onRun(text: string): void }): Tool {
  const { resume, onRun } = params;
  return defineTool({
    name: 'save_note', description: 'Save a note', args: z.object({ text: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true, ...(resume == null ? {} : { resume }),
    describeActivity: () => ({ title: 'save' }), run: async ({ text }) => { onRun(text); return `saved ${text}`; },
  });
}

/** Crashes the first runtime inside the first `save_note` call, then resumes on a second one. */
async function crashInFirstNote(params: { resume?: 'skip' | 'ask' }) {
  const base = createInMemoryStore();
  let now = 1_000;
  const process = crashableStore({ store: base });
  const runs = new Map<string, number>();
  const tools = (isFirst: boolean): Tool[] => {
    const [, read] = worldTools({ world: createWorld() });
    return [policyNote({ ...params, onRun: text => { runs.set(text, (runs.get(text) ?? 0) + 1); if (isFirst && text === 'first') { process.crash(); throw new Error('crash'); } } }), read!];
  };
  const aiA = runtimeOver({ store: process.store, provider: scriptedProvider(), now: () => now });
  await aiA.agent(definitionFor(tools(true))).task(TASK).then(() => undefined, () => undefined);
  await aiA.close();
  now += LEASE_TTL_MS + 1;
  const aiB = runtimeOver({ store: base, provider: scriptedProvider(), now: () => now });
  const agent = aiB.agent(definitionFor(tools(false)));
  await agent.ready;
  const run = agent.resume()!;
  const events = await collect(run);
  const result = await run;
  await aiB.close();
  return { result, events, runsOf: (text: string) => runs.get(text) ?? 0 };
}

describe('agent.resume', () => {
  it('returns undefined when nothing was interrupted, or without resume on the runtime', async () => {
    const ai = runtimeOver({ store: createInMemoryStore(), provider: scriptedProvider(), now: () => 1 });
    const agent = ai.agent(definitionFor(worldTools({ world: createWorld() })));
    await agent.ready;
    expect(agent.resume()).toBeUndefined();
    await agent.task(TASK);
    expect(agent.resume()).toBeUndefined();
    await ai.close();
    const plain = runtimeOver({ store: createInMemoryStore(), provider: scriptedProvider(), now: () => 1, options: { resume: undefined } });
    expect(plain.agent(definitionFor([])).resume()).toBeUndefined();
  });

  it('refuses a second live owner with instance_locked, hands over after expiry and fences the old owner', async () => {
    const store = createInMemoryStore();
    let now = 1_000;
    const first = runtimeOver({ store, provider: scriptedProvider(), now: () => now });
    const held = first.agent(definitionFor([]));
    await held.ready;
    const second = runtimeOver({ store, provider: scriptedProvider(), now: () => now });
    await expect(second.agent(definitionFor([])).ready).rejects.toMatchObject({ code: 'instance_locked', details: { instanceId: INSTANCE_ID } });
    await expect(second.restoreAgent(INSTANCE_ID)).rejects.toMatchObject({ code: 'instance_locked' });
    now += LEASE_TTL_MS + 1;
    const third = runtimeOver({ store, provider: scriptedProvider(), now: () => now });
    const taken = third.agent(definitionFor(worldTools({ world: createWorld() })));
    await taken.ready;
    expect((await store.get<LeaseRecord>(LEASES_COLLECTION, INSTANCE_ID))?.value.fence).toBe(2);
    // The old owner's run cannot write a single checkpoint any more.
    const late = await held.task(TASK);
    expect(late).toMatchObject({ status: 'failed', failure: expect.stringContaining('was taken over') });
    expect(await taken.task(TASK)).toMatchObject({ status: 'completed', answer: SCRIPT_ANSWER });
    await Promise.all([first.close(), third.close()]);
  });

  it('refuses to re-run an interrupted call that needs approval in an unattended run, and the model sees why', async () => {
    const { result, events, runsOf } = await crashInFirstNote({});
    expect(runsOf('first')).toBe(1);
    expect(events).toContainEqual({ type: 'tool-result', callId: 'n1', envelope: expect.objectContaining({ ok: false, error: expect.objectContaining({ category: 'denied', code: 'approval_denied' }) }) });
    expect(result.status).toBe('completed');
  });

  it('gives a skipped result for resume: skip and never runs the call again', async () => {
    const { events, runsOf } = await crashInFirstNote({ resume: 'skip' });
    expect(runsOf('first')).toBe(1);
    expect(events).toContainEqual({ type: 'tool-result', callId: 'n1', envelope: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'skipped' }) }) });
  });

  it('continues a gracefully stopped task from its preserved state, and restores the run state exactly', async () => {
    const store = createInMemoryStore();
    const world = createWorld();
    const ai = runtimeOver({ store, provider: scriptedProvider(), now: () => 1_000 });
    const run = ai.agent(definitionFor(worldTools({ world }))).task(TASK);
    run.onToolActivity(() => run.stop({ mode: 'graceful' }));
    const stopped = await run;
    expect(stopped.status).toBe('stopped');
    const before = await readLatestCheckpoint({ store, instanceId: INSTANCE_ID, streamId: stopped.runId });
    await ai.close();
    const provider = scriptedProvider();
    const restarted = runtimeOver({ store, provider, now: () => 2_000 });
    restarted.agent({ ...definitionFor(worldTools({ world })), instanceId: 'another' });
    const agent = await restarted.restoreAgent(INSTANCE_ID);
    const resumed = agent.resume({ runId: stopped.runId });
    expect(resumed?.runId).toBe(stopped.runId);
    const result = await resumed!;
    expect(result).toMatchObject({ status: 'completed', answer: SCRIPT_ANSWER });
    expect(world.runs.get('save_note')).toBe(2);
    expect(before?.state.kind === 'run' ? before.state.status : undefined).toBe('stopped');
    // Field by field, the restored history is exactly the stored one: the first resumed request sends it as it was.
    const stored = before?.state.kind === 'run' ? before.state.context.messages.map(({ message }) => message) : [];
    expect(provider.requests[0]?.messages.filter(({ volatile }) => volatile !== true)).toEqual(stored);
    await restarted.close();
  });

  it('restoreAgent rebuilds an instance from a known definition, warning about a new agent version', async () => {
    const store = createInMemoryStore();
    const first = runtimeOver({ store, provider: scriptedProvider(), now: () => 1_000 });
    await first.agent(definitionFor(worldTools({ world: createWorld() }))).task(TASK);
    await first.close();
    const second = runtimeOver({ store, provider: scriptedProvider(), now: () => 2_000 });
    await expect(second.restoreAgent(INSTANCE_ID)).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining("define it with ai.agent first") });
    second.agent({ ...definitionFor(worldTools({ world: createWorld() })), instanceId: 'other', persona: 'A changed persona' });
    const restored = await second.restoreAgent(INSTANCE_ID);
    expect(restored.instanceId).toBe(INSTANCE_ID);
    const events = await collect(restored.task(TASK));
    expect(events).toContainEqual({ type: 'warning', message: expect.stringContaining(`Agent instance '${INSTANCE_ID}' was stored by agent version`) });
    await second.close();
  });
});
