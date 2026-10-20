import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAigent } from '../core/create-aigent.js';
import type { AigentEvent } from '../core/aigent-events.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { worldSnapshot, worldTools } from './world.test-support.js';
import type { World } from './world.test-support.js';

function setup(turns: FakeTurn[], world: World = new Map([['/a.txt', 'old a'], ['/b.txt', 'old b']])) {
  const provider = createFakeProvider({ turns });
  const tools = worldTools(world);
  const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false });
  const agent = ai.agent({ name: 'helper', model: 'fake:m', tools: [tools.write, tools.remove, tools.writeMany, tools.unsafe, tools.read] });
  return { ai, agent, provider, world, tools };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function seen(provider: ReturnType<typeof createFakeProvider>, request: number, callId: string): { ok: boolean; result?: unknown; error?: unknown } {
  return JSON.parse(provider.requests[request]!.messages.find(({ toolCallId }) => toolCallId === callId)!.text!);
}

const WRITE = { id: 'w1', name: 'write_file', args: { path: '/a.txt', content: 'new a' } };
const DELETE = { id: 'd1', name: 'delete_file', args: { path: '/b.txt' } };
const BATCH = { id: 'm1', name: 'write_files', args: { items: [{ path: '/c.txt', content: 'c' }, { path: '/d.txt', content: 'd' }] } };
const READ = { id: 'r1', name: 'read_file', args: { path: '/a.txt' } };

describe('dry run', () => {
  it('leaves the world byte-identical, runs read-only tools for real and returns the planned effects in order', async () => {
    const { agent, provider, world, tools } = setup([toolTurn([READ, WRITE, DELETE, BATCH]), textTurn('Planned.')]);
    const before = worldSnapshot(world);
    const run = agent.task({ task: 'tidy up', dryRun: true });
    const events = await collect(run);
    const result = await run;
    expect(worldSnapshot(world)).toBe(before);
    expect(tools.runs).toEqual(['read /a.txt']);
    expect(seen(provider, 1, 'r1')).toMatchObject({ ok: true, result: 'old a' });
    expect(seen(provider, 1, 'w1')).toEqual({ id: 'w1', tool: 'write_file', ok: true, result: { simulated: true, effects: [expect.objectContaining({ kind: 'file.write', target: '/a.txt' })] } });
    expect(seen(provider, 1, 'd1')).toMatchObject({ ok: true, result: { simulated: true, result: { wouldDelete: true } } });
    expect(result.plannedEffects).toEqual([
      { tool: 'write_file', callId: 'w1', kind: 'file.write', target: '/a.txt', summary: 'write 5 characters to /a.txt', before: 'old a', after: 'new a', reversible: true },
      { tool: 'delete_file', callId: 'd1', kind: 'file.delete', target: '/b.txt', summary: 'delete /b.txt', reversible: true },
      { tool: 'write_files', callId: 'm1', kind: 'file.write', target: '/c.txt', summary: 'write /c.txt', reversible: true },
      { tool: 'write_files', callId: 'm1', kind: 'file.write', target: '/d.txt', summary: 'write /d.txt', reversible: true },
    ]);
    expect(events.filter(({ type }) => type === 'planned-effects').map(event => (event as { callId: string }).callId)).toEqual(['w1', 'd1', 'm1']);
    // The model is told the results are simulated.
    expect(provider.requests[0]!.messages.at(-1)?.text).toContain('This is a dry run');
  });

  it('refuses a mutating tool without dryRun (it never runs), and propagates through aigent_multi per item', async () => {
    const multi = { id: 'x1', name: 'aigent_multi', args: { calls: [{ id: 'i1', tool: 'write_file', args: WRITE.args }, { id: 'i2', tool: 'format_disk', args: {} }] } };
    const { agent, provider, world, tools } = setup([toolTurn([{ id: 'f1', name: 'format_disk', args: {} }, multi]), textTurn('ok')]);
    const before = worldSnapshot(world);
    const result = await agent.task({ task: 'format', dryRun: true });
    expect(worldSnapshot(world)).toBe(before);
    expect(tools.runs).toEqual([]);
    expect(seen(provider, 1, 'f1')).toMatchObject({ ok: false, error: { category: 'denied', code: 'dry_run_unsupported' } });
    expect(seen(provider, 1, 'x1')).toMatchObject({ ok: true, result: [{ id: 'i1', ok: true, result: { simulated: true } }, { id: 'i2', ok: false, error: { code: 'dry_run_unsupported' } }] });
    expect(result.plannedEffects).toEqual([expect.objectContaining({ tool: 'write_file', callId: 'i1', target: '/a.txt' })]);
  });

  it('marks the run record, and a later real run really writes (nothing simulated was cached)', async () => {
    const { ai, agent, world } = setup([toolTurn([WRITE]), textTurn('Planned.'), toolTurn([WRITE]), textTurn('Done.')]);
    const dry = agent.task({ task: 'write', dryRun: true });
    await dry;
    expect((await ai.trace(dry.runId))?.run).toMatchObject({ dryRun: true, plannedEffects: [expect.objectContaining({ target: '/a.txt' })] });
    const real = await agent.task({ task: 'write' });
    expect(real.plannedEffects).toBeUndefined();
    expect(world.get('/a.txt')).toBe('new a');
  });

  it('works in a chat turn', async () => {
    const { agent, world } = setup([toolTurn([DELETE]), textTurn('Would delete it.')]);
    const chat = agent.chat({ dryRun: true });
    const reply = await chat.send('delete b');
    await chat.close();
    expect(reply.text).toBe('Would delete it.');
    expect(world.has('/b.txt')).toBe(true);
  });

  it('only lets tools with side effects declare dryRun', () => {
    expect(() => defineTool({
      name: 'lookup', description: 'x', args: z.object({}).strict(), deterministic: false, cache: false, describeActivity: () => ({ title: 'x' }), run: async () => 1, dryRun: async () => [],
    })).toThrow(/dryRun only applies to tools with side effects/);
  });
});
