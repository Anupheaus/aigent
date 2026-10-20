import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { Store } from '../store/store-types.js';
import { createInMemoryStore, definitionFor, runtimeOver, worldTools, createWorld } from './crash-injection.test-support.js';

const OUTPUT = z.object({ notes: z.number() }).strict();

/** A store that keeps values as JSON, like any database: class instances (a zod schema) do not survive. */
function jsonStore(): Store {
  const store = createInMemoryStore();
  return { ...store, compareAndSet: async write => store.compareAndSet({ ...write, value: JSON.parse(JSON.stringify(write.value)) as unknown }) };
}

describe('resuming a task with a structured output', () => {
  it('needs the output schema again from a JSON store, and then settles its output', async () => {
    const store = jsonStore();
    const first = runtimeOver({ store, provider: createFakeProvider({ turns: [toolTurn([{ id: 'r1', name: 'read_file', args: { path: 'a.txt' } }]), textTurn('{"notes":1}')] }), now: () => 1_000 });
    const run = first.agent(definitionFor(worldTools({ world: createWorld() }))).task({ task: 'count', unattended: true, output: OUTPUT });
    run.onToolActivity(() => run.stop({ mode: 'graceful' }));
    expect((await run).status).toBe('stopped');
    await first.close();
    const second = runtimeOver({ store, provider: createFakeProvider({ turns: [textTurn('{"notes":2}')] }), now: () => 2_000 });
    const agent = second.agent(definitionFor(worldTools({ world: createWorld() })));
    await agent.ready;
    expect(() => agent.resume()).toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringMatching(/agent\.resume\(\{ output \}\)/) }));
    const resumed = agent.resume({ output: OUTPUT });
    expect(await resumed!).toMatchObject({ status: 'completed', output: { notes: 2 } });
    await second.close();
  });
});
