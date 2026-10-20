import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAigent } from '../core/create-aigent.js';
import type { AigentOptions } from '../core/aigent-types.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import type { ToolCall } from '../providers/provider-types.js';
import { defineTool } from '../tools/define-tool.js';
import { EFFECTS_COLLECTION } from './undo-types.js';
import type { EffectLogEntry } from './undo-types.js';
import { worldSnapshot, worldTools } from './world.test-support.js';
import type { World } from './world.test-support.js';

const INITIAL: [string, string][] = [['/a.txt', 'old a']];

function write(id: string, path: string, content: string): ToolCall {
  return { id, name: 'write_file', args: { path, content } };
}

/** One call per turn, so the effects happen in call order, then a final answer. */
function oneByOne(calls: ToolCall[]): FakeTurn[] {
  return [...calls.map(call => toolTurn([call])), textTurn('done')];
}

function setup(params: { turns: FakeTurn[]; world?: World; store?: Store; runtime?: Partial<AigentOptions>; now?: { value: number } }) {
  const { turns, world = new Map(INITIAL), store = createInMemoryStore(), runtime = {}, now = { value: 1_000 } } = params;
  const provider = createFakeProvider({ turns });
  const tools = worldTools(world);
  const ai = createAigent({ providers: [provider], store, enableFeedback: false, clock: { now: () => now.value }, ...runtime });
  const agent = ai.agent({ name: 'helper', model: 'fake:m', tools: [tools.write, tools.remove, tools.unsafe] });
  return { ai, agent, world, tools, store, now };
}

describe('effect log and agent.undo', () => {
  it('reverses five effects of a run newest first, restoring the world, and records each undo', async () => {
    const calls = [write('c1', '/a.txt', 'v1'), write('c2', '/a.txt', 'v2'), write('c3', '/b.txt', 'b'), { id: 'c4', name: 'delete_file', args: { path: '/b.txt' } }, write('c5', '/c.txt', 'c')];
    const { agent, world, store } = setup({ turns: oneByOne(calls) });
    const before = worldSnapshot(new Map(INITIAL));
    const run = agent.task({ task: 'edit' });
    await run;
    const report = await agent.undo({ runId: run.runId });
    expect(report.results.map(({ callId, status }) => [callId, status])).toEqual([['c5', 'undone'], ['c4', 'undone'], ['c3', 'undone'], ['c2', 'undone'], ['c1', 'undone']]);
    expect(worldSnapshot(world)).toBe(before);
    const entries = (await store.list<EffectLogEntry>(EFFECTS_COLLECTION)).map(({ value }) => value);
    expect(entries.filter(({ kind }) => kind === 'undo')).toHaveLength(5);
    expect(entries.filter(({ kind }) => kind === 'effect').every(({ status }) => status === 'undone')).toBe(true);
  });

  it('keeps going past a failing undo and reports each effect precisely; a second undo is already_undone', async () => {
    const { agent, world } = setup({ turns: oneByOne([write('x', '/x.txt', '1'), write('f', '/fail', '2'), write('y', '/y.txt', '3')]) });
    const run = agent.task({ task: 'edit' });
    await run;
    const report = await agent.undo({ runId: run.runId });
    expect(report.results).toEqual([
      { effectId: expect.any(String), callId: 'y', tool: 'write_file', status: 'undone' },
      { effectId: expect.any(String), callId: 'f', tool: 'write_file', status: 'failed', message: expect.stringMatching(/cannot restore \/fail/) },
      { effectId: expect.any(String), callId: 'x', tool: 'write_file', status: 'undone' },
    ]);
    expect(world.has('/x.txt') || world.has('/y.txt')).toBe(false);
    const again = await agent.undo({ runId: run.runId });
    expect(again.results.map(({ callId, status }) => [callId, status])).toEqual([['y', 'already_undone'], ['f', 'failed'], ['x', 'already_undone']]);
  });

  it('honours undo retention, reports tools that cannot undo, and targets one call or a time', async () => {
    const now = { value: 1_000 };
    const { agent, world } = setup({ turns: oneByOne([write('a', '/a.txt', 'A'), { id: 'z', name: 'format_disk', args: {} }, write('b', '/b.txt', 'B')]), runtime: { undo: { retentionMs: 500 } }, now });
    const run = agent.task({ task: 'edit' });
    await run;
    expect((await agent.undo({ callId: 'z' })).results).toEqual([{ effectId: expect.any(String), callId: 'z', tool: 'format_disk', status: 'unavailable', message: expect.stringMatching(/cannot be undone/) }]);
    expect((await agent.undo({ since: 0 })).results.map(({ callId, status }) => [callId, status])).toEqual([['b', 'undone'], ['z', 'unavailable'], ['a', 'undone']]);
    world.set('/b.txt', 'B');
    const later = setup({ turns: oneByOne([write('c', '/c.txt', 'C')]), runtime: { undo: { retentionMs: 500 } }, now });
    const second = later.agent.task({ task: 'edit' });
    await second;
    now.value += 1_000;
    expect((await later.agent.undo({ runId: second.runId })).results).toEqual([{ effectId: expect.any(String), callId: 'c', tool: 'write_file', status: 'expired' }]);
    expect(later.world.get('/c.txt')).toBe('C');
  });

  it('serialises concurrent undos of one run: each effect is undone once', async () => {
    const { agent, tools } = setup({ turns: oneByOne([write('a', '/n1', '1'), write('b', '/n2', '2')]) });
    const run = agent.task({ task: 'edit' });
    await run;
    const [first, second] = await Promise.all([agent.undo({ runId: run.runId }), agent.undo({ runId: run.runId })]);
    expect([...first!.results, ...second!.results].map(({ status }) => status).sort()).toEqual(['already_undone', 'already_undone', 'undone', 'undone']);
    expect(tools.undone).toEqual(['/n2', '/n1']);
  });

  it('undoes from a fresh runtime on the same store, and marks undoable steps in the trace', async () => {
    const store = createInMemoryStore();
    const world: World = new Map(INITIAL);
    const first = setup({ turns: oneByOne([write('a', '/a.txt', 'changed'), { id: 'z', name: 'format_disk', args: {} }]), world, store });
    const run = first.agent.task({ task: 'edit' });
    await run;
    await first.ai.close();
    const steps = (await first.ai.trace(run.runId))?.steps ?? [];
    expect(steps.map(({ tool, undoable }) => [tool, undoable === true])).toEqual([['write_file', true], ['format_disk', false]]);
    world.set('/a.txt', 'changed');
    const fresh = setup({ turns: [], world, store });
    expect((await fresh.agent.undo({ runId: run.runId, callId: 'a' })).results).toMatchObject([{ status: 'undone' }]);
    expect(world.get('/a.txt')).toBe('old a');
  });

  it('requires undo and applyUndo together, on tools with side effects only', () => {
    const base = { description: 'x', args: z.object({}).strict(), deterministic: false, cache: false, describeActivity: () => ({ title: 'x' }), run: async () => 1 };
    expect(() => defineTool({ ...base, name: 'half', hasSideEffects: true, undo: async () => ({}) })).toThrow(/undo and applyUndo go together/);
    expect(() => defineTool({ ...base, name: 'reader', undo: async () => ({}), applyUndo: async () => ({ ok: true }) })).toThrow(/undo only applies to tools with side effects/);
  });
});
