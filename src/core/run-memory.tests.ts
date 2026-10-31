import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../memory/memory-store.js';
import { MEMORY_COLLECTION } from '../memory/memory-types.js';
import type { MemoryEntry, ResolvedMemoryOptions } from '../memory/memory-types.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createWriteQueue } from '../store/write-queue.js';
import type { NoteMemoryParams } from '../telemetry/trace-recorder.js';
import type { AigentEvent } from './aigent-events.js';
import { createRunMemory } from './run-memory.js';
import type { CreateRunMemoryParams } from './run-memory.js';

const OPTIONS: ResolvedMemoryOptions = { scope: 'agent', maxEntries: 200, maxPerCall: 2, halfLifeDays: 30, minConfidence: 0.2, recallLimit: 6 };

function setup(overrides: Partial<CreateRunMemoryParams> = {}) {
  const store = createInMemoryStore();
  const warnings: string[] = [];
  const noted: NoteMemoryParams[] = [];
  const memory = createRunMemory({
    store: createMemoryStore({ store, writeQueue: createWriteQueue(), now: () => 1_000 }), options: OPTIONS, agentName: 'helper', runId: 'run_1', scopeKey: 'agent',
    recorder: { noteMemory: note => { noted.push(note); } },
    emit: (event: AigentEvent) => { if (event.type === 'warning') warnings.push(event.message); },
    ...overrides,
  });
  const entries = async (): Promise<MemoryEntry[]> => (await store.list<MemoryEntry>(MEMORY_COLLECTION)).map(({ value }) => value);
  return { memory, warnings, noted, entries };
}

describe('createRunMemory', () => {
  it('takes memory out of the call and saves it with the call as its source', async () => {
    const { memory, noted, entries, warnings } = setup();
    const call = memory.take({ id: 'call_1', name: 'read', args: { path: 'a', memory: [{ kind: 'fact', text: 'Docs are in docs/', tags: null, pinned: null }] } });
    expect(call).toEqual({ id: 'call_1', name: 'read', args: { path: 'a' } });
    expect(await memory.flush()).toEqual({ saved: 1, evicted: 0 });
    expect(noted).toEqual([{ callId: 'call_1', saved: 1, rejected: 0 }]);
    expect((await entries()).map(({ text, source }) => ({ text, source }))).toEqual([{ text: 'Docs are in docs/', source: { runId: 'run_1', callId: 'call_1', origin: 'tool-call' } }]);
    expect(warnings).toEqual([]);
  });

  it('warns about rejected notes, naming the call and tool, and still saves the valid ones', async () => {
    const { memory, noted, warnings } = setup();
    memory.take({ id: 'call_2', name: 'read', args: { memory: [{ kind: 'guess', text: 'x' }, { kind: 'fact', text: 'kept' }, { kind: 'fact', text: 'over the limit' }] } });
    expect(await memory.flush()).toEqual({ saved: 1, evicted: 0 });
    expect(noted).toEqual([{ callId: 'call_2', saved: 1, rejected: 2 }]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^Memory on call 'call_2' to 'read': 3 memory notes sent but at most 2/);
    expect(warnings[1]).toMatch(/^Memory on call 'call_2' to 'read': memory note 1 was not saved: kind/);
  });

  it('notes nothing for a null field', async () => {
    const { memory, noted, warnings } = setup();
    expect(memory.take({ id: 'c', name: 'read', args: { path: 'a', memory: null } }).args).toEqual({ path: 'a' });
    expect(await memory.flush()).toEqual({ saved: 0, evicted: 0 });
    expect(noted).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('saves the top level of aigent_multi and drops memory on inner calls with a warning', async () => {
    const { memory, warnings, entries } = setup();
    const call = memory.take({ id: 'm1', name: 'aigent_multi', args: { memory: [{ kind: 'fact', text: 'top' }], calls: [{ id: 'one', tool: 'read', args: { path: 'a', memory: [{ kind: 'fact', text: 'inner' }] } }] } });
    expect(call.args).toEqual({ calls: [{ id: 'one', tool: 'read', args: { path: 'a' } }] });
    await memory.flush();
    expect((await entries()).map(({ text }) => text)).toEqual(['top']);
    expect(warnings).toEqual(["Ignored memory inside aigent_multi call 'm1' (inner calls 'one'); only the aigent_multi call itself carries memory"]);
  });

  it('saves nothing when the run may not write, saying why once per run', async () => {
    const { memory, warnings, noted, entries } = setup({ skipReason: 'this is a dry run' });
    memory.take({ id: 'a', name: 'read', args: { memory: [{ kind: 'fact', text: 'one' }] } });
    memory.take({ id: 'b', name: 'read', args: { memory: [{ kind: 'fact', text: 'two' }] } });
    expect(await memory.flush()).toEqual({ saved: 0, evicted: 0 });
    expect(await entries()).toEqual([]);
    expect(noted).toEqual([{ callId: 'a', saved: 0, rejected: 1 }, { callId: 'b', saved: 0, rejected: 1 }]);
    expect(warnings).toEqual(['Memory notes are not saved: this is a dry run']);
  });

  it('reports store problems as warnings and counts the note as rejected', async () => {
    const store = createInMemoryStore();
    const failing = { ...store, compareAndSet: async () => { throw new Error('disk full'); } };
    const { memory, warnings, noted } = setup({ store: createMemoryStore({ store: failing, writeQueue: createWriteQueue(), now: () => 1 }) });
    memory.take({ id: 'c', name: 'read', args: { memory: [{ kind: 'fact', text: 'x' }] } });
    expect(await memory.flush()).toEqual({ saved: 0, evicted: 0 });
    expect(warnings).toEqual(["Memory on call 'c' to 'read': memory note 1 was not saved: disk full"]);
    expect(noted).toEqual([{ callId: 'c', saved: 0, rejected: 1 }]);
  });
});
