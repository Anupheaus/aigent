// Test-only setup for chat tests. Excluded from the build and never exported.
import { z } from 'zod';
import type { AigentEvent } from '../core/aigent-events.js';
import { createAigent } from '../core/create-aigent.js';
import type { AigentOptions } from '../core/aigent-types.js';
import type { AgentDefinition } from '../core/agent-types.js';
import type { IdGenerator } from '../core/runtime-services.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createFakeProvider } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';

export function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

export const echoTool = defineTool({
  name: 'echo', description: 'Echo text', args: z.object({ text: z.string() }).strict(), deterministic: false, cache: false,
  describeActivity: args => ({ title: `Echo ${args.text}` }), run: async ({ text }) => text,
});

/** A store that records every write, per collection. */
export function spyStore(): Store & { writes: string[] } {
  const store = createInMemoryStore();
  const writes: string[] = [];
  return {
    ...store,
    compareAndSet: params => { writes.push(params.collection); return store.compareAndSet(params); },
    writes,
  };
}

export interface ChatSetupOptions {
  turns: FakeTurn[];
  store?: Store;
  runtime?: Partial<AigentOptions>;
  agent?: Partial<AgentDefinition>;
}

export function chatSetup(options: ChatSetupOptions) {
  const { turns, store, runtime = {}, agent: definition = {} } = options;
  const provider = createFakeProvider({ turns });
  let now = 1_000;
  const ai = createAigent({ providers: [provider], clock: { now: () => (now += 1) }, ids: sequentialIds(), enableFeedback: false, ...(store == null ? {} : { store }), ...runtime });
  const agent = ai.agent({ name: 'helper', model: 'fake:m', tools: [echoTool], ...definition });
  return { provider, ai, agent };
}

export async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
