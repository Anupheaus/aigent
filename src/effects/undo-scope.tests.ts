import { describe, expect, it } from 'vitest';
import { createAigent } from '../core/create-aigent.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import type { ToolCall } from '../providers/provider-types.js';
import type { AigentEvent } from '../core/aigent-events.js';
import { worldTools } from './world.test-support.js';
import type { World } from './world.test-support.js';

function write(id: string, path: string, content: string): ToolCall {
  return { id, name: 'write_file', args: { path, content } };
}

/** Two instances of one agent definition (e.g. two users), sharing the runtime and its store. */
function twoInstances(params: { turns: FakeTurn[] }) {
  const world: World = new Map();
  const tools = worldTools(world);
  const ai = createAigent({ providers: [createFakeProvider({ turns: params.turns })], store: createInMemoryStore(), enableFeedback: false });
  const definition = { name: 'helper', model: 'fake:m', tools: [tools.write] };
  return { world, alice: ai.agent({ ...definition, instanceId: 'alice' }), bob: ai.agent({ ...definition, instanceId: 'bob' }) };
}

describe('undo scope', () => {
  it('undoes only the calling instance\'s effects by default; scope agent widens it, and an ambiguous call id is refused', async () => {
    // Providers that omit ids give every run the same `call_0`.
    const { world, alice, bob } = twoInstances({ turns: [toolTurn([write('call_0', '/alice', 'a')]), textTurn('ok'), toolTurn([write('call_0', '/bob', 'b')]), textTurn('ok')] });
    await alice.task({ task: 'write' });
    await bob.task({ task: 'write' });
    expect((await alice.undo({ callId: 'call_0' })).results.map(({ status }) => status)).toEqual(['undone']);
    expect([...world.keys()]).toEqual(['/bob']);
    world.set('/alice', 'a');
    await expect(alice.undo({ callId: 'call_0', scope: 'agent' })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/more than one run/) });
    expect((await alice.undo({ since: 0, scope: 'agent' })).results.map(({ status }) => status)).toEqual(['undone', 'already_undone']);
    expect([...world.keys()]).toEqual(['/alice']);
  });

  it('gives repeated provider call ids within a run unique ids, so each call keeps its own effect', async () => {
    const { world, alice } = twoInstances({ turns: [toolTurn([write('dup', '/one', '1')]), toolTurn([write('dup', '/two', '2')]), textTurn('ok')] });
    const run = alice.task({ task: 'write twice' });
    const events: AigentEvent[] = [];
    for await (const event of run) events.push(event);
    const { runId } = await run;
    const ids = events.flatMap(event => (event.type === 'tool-result' ? [event.callId] : []));
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe('dup');
    const report = await alice.undo({ runId, callId: ids[1]! });
    expect(report.results).toEqual([expect.objectContaining({ callId: ids[1], status: 'undone' })]);
    expect([...world.keys()]).toEqual(['/one']);
  });
});
