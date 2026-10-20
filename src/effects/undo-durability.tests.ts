import { describe, expect, it } from 'vitest';
import { createAigent } from '../core/create-aigent.js';
import { crashableStore, definitionFor, LEASE_TTL_MS, runtimeOver } from '../resume/crash-injection.test-support.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import type { RedactableRecord } from '../telemetry/redact.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import type { ToolCall } from '../providers/provider-types.js';
import { EFFECTS_COLLECTION } from './undo-types.js';
import type { EffectLogEntry } from './undo-types.js';
import { worldTools } from './world.test-support.js';
import type { World } from './world.test-support.js';

function write(id: string, path: string, content: string): ToolCall {
  return { id, name: 'write_file', args: { path, content } };
}

function oneByOne(calls: ToolCall[]): FakeTurn[] {
  return [...calls.map(call => toolTurn([call])), textTurn('done')];
}

/** Masks e-mail addresses in every stored record, as a typical privacy hook does. */
function maskEmails(record: RedactableRecord): RedactableRecord {
  return { ...record, value: JSON.parse(JSON.stringify(record.value).replace(/[\w.]+@[\w.]+/g, '[email]')) as unknown };
}

describe('undo data durability', () => {
  it('refuses to apply undo data that redact changed, instead of restoring corrupted content', async () => {
    const world: World = new Map([['/contact.txt', 'contact ada@example.org']]);
    const tools = worldTools(world);
    const ai = createAigent({ providers: [createFakeProvider({ turns: oneByOne([write('w1', '/contact.txt', 'nobody')]) })], store: createInMemoryStore(), enableFeedback: false, redact: maskEmails });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', tools: [tools.write] });
    const run = agent.task({ task: 'edit' });
    await run;
    const report = await agent.undo({ runId: run.runId });
    expect(report.results).toEqual([expect.objectContaining({ callId: 'w1', status: 'unavailable', message: expect.stringMatching(/redact/) })]);
    expect(world.get('/contact.txt')).toBe('nobody');
  });

  it('a store failure while recording an undo neither stops the other undos nor lets them apply twice', async () => {
    const base = createInMemoryStore();
    let isFailing = false;
    const store: Store = { ...base, compareAndSet: async write => { if (isFailing && write.collection === EFFECTS_COLLECTION) throw new Error('store down'); return base.compareAndSet(write); } };
    const world: World = new Map();
    const tools = worldTools(world);
    const ai = createAigent({ providers: [createFakeProvider({ turns: oneByOne([write('a', '/a', '1'), write('b', '/b', '2')]) })], store, enableFeedback: false });
    const agent = ai.agent({ name: 'helper', model: 'fake:m', tools: [tools.write] });
    const run = agent.task({ task: 'edit' });
    await run;
    isFailing = true;
    const report = await agent.undo({ runId: run.runId });
    expect(report.results).toEqual([
      expect.objectContaining({ callId: 'b', status: 'undone', message: expect.stringMatching(/not recorded/) }),
      expect.objectContaining({ callId: 'a', status: 'undone', message: expect.stringMatching(/not recorded/) }),
    ]);
    const again = await agent.undo({ runId: run.runId });
    expect(again.results.map(({ status }) => status)).toEqual(['already_undone', 'already_undone']);
    expect(tools.undone).toEqual(['/b', '/a']);
  });

  it('keeps the undo data of a call whose effect-log write was lost in a crash, from the call ledger', async () => {
    const base = createInMemoryStore();
    let now = 1_000;
    const world: World = new Map([['/a.txt', 'old']]);
    const process = crashableStore({ store: base, beforeWrite: ({ collection }) => { if (collection === EFFECTS_COLLECTION) process.crash(); } });
    const turns = oneByOne([write('w1', '/a.txt', 'new')]);
    const aiA = runtimeOver({ store: process.store, provider: createFakeProvider({ turns }), now: () => now });
    await aiA.agent(definitionFor([worldTools(world).write])).task({ task: 'edit', unattended: true }).then(() => undefined, () => undefined);
    await aiA.close();
    expect(process.isCrashed()).toBe(true);
    expect(await base.list(EFFECTS_COLLECTION)).toEqual([]);
    now += LEASE_TTL_MS + 1;
    const aiB = runtimeOver({ store: base, provider: createFakeProvider({ turns: [textTurn('done')] }), now: () => now });
    const agent = aiB.agent(definitionFor([worldTools(world).write]));
    await agent.ready;
    const resumed = await agent.resume()!;
    expect(resumed.status).toBe('completed');
    expect((await base.list<EffectLogEntry>(EFFECTS_COLLECTION)).map(({ value: { callId, kind } }) => [callId, kind])).toEqual([['w1', 'effect']]);
    expect((await agent.undo({ runId: resumed.runId })).results).toEqual([expect.objectContaining({ callId: 'w1', status: 'undone' })]);
    expect(world.get('/a.txt')).toBe('old');
    await aiB.close();
  });
});
