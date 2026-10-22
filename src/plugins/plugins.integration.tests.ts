import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAigent } from '../core/create-aigent.js';
import type { AigentEvent } from '../core/aigent-events.js';
import type { Clock, IdGenerator } from '../core/runtime-services.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { definePlugin } from './define-plugin.js';
import { pluginTools } from './plugin-tools.js';
import type { PluginHooks, ToolCallInfo } from './plugin-types.js';

const clock: Clock = { now: () => 1_000 };
function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

const shout = defineTool({
  name: 'shout', description: 'Upper-case text', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false,
  describeActivity: ({ text }) => ({ title: `Shout ${text}` }), run: async ({ text }) => text.toUpperCase(),
});

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function warnings(events: AigentEvent[]): string[] {
  return events.flatMap(event => (event.type === 'warning' ? [event.message] : []));
}

describe('plugins wired into createAigent', () => {
  it('adds a provider and a tool pack with one line each', async () => {
    const provider = createFakeProvider({ id: 'plugged', turns: [toolTurn([{ id: 'c1', name: 'shout', args: { text: 'hi' } }]), textTurn('HI')] });
    const ai = createAigent({ plugins: [definePlugin({ name: 'my-pack', version: '1.0.0', providers: [provider], tools: [shout] })], clock, ids: sequentialIds() });
    const agent = ai.agent({ name: 'helper', model: 'plugged:m', tools: [pluginTools('my-pack')], enableFeedback: false });
    const result = await agent.task({ task: 'Shout hi' });
    expect(result).toMatchObject({ status: 'completed', answer: 'HI' });
    expect(provider.requests[0]?.tools.map(({ name }) => name)).toContain('shout');
  });

  it('does not add plugin tools to agents that do not ask for them', async () => {
    const provider = createFakeProvider({ turns: [textTurn('ok')] });
    const ai = createAigent({ providers: [provider], plugins: [definePlugin({ name: 'pack', version: '1.0.0', tools: [shout] })], clock, ids: sequentialIds() });
    await ai.agent({ name: 'plain', model: 'fake:m', enableFeedback: false }).task({ task: 'x' });
    expect(provider.requests[0]?.tools.map(({ name }) => name)).not.toContain('shout');
  });

  it('accepts plugins with ai.use after creation', async () => {
    const ai = createAigent({ clock, ids: sequentialIds() });
    const provider = createFakeProvider({ id: 'late', turns: [textTurn('late answer')] });
    expect(() => ai.agent({ name: 'early', model: 'late:m' })).toThrow("Unknown provider 'late'");
    ai.use(definePlugin({ name: 'late-plugin', version: '0.1.0', providers: [provider] }));
    const result = await ai.agent({ name: 'later', model: 'late:m' }).task({ task: 'x' });
    expect(result.answer).toBe('late answer');
    expect(() => ai.use(definePlugin({ name: 'late-plugin', version: '0.2.0' }))).toThrow("Plugin 'late-plugin' is already registered");
  });

  it('rejects provider id collisions between plugins and direct providers at createAigent', () => {
    expect(() => createAigent({ providers: [createFakeProvider({ turns: [] })], plugins: [definePlugin({ name: 'dup', version: '1.0.0', providers: [createFakeProvider({ turns: [] })] })] }))
      .toThrow("Provider id 'fake' from plugin 'dup' collides with provider 'fake' from createAigent({ providers })");
  });

  it('selects a plugin store by id for run records', async () => {
    const store = createInMemoryStore();
    const ai = createAigent({ providers: [createFakeProvider({ turns: [textTurn('stored')] })], plugins: [definePlugin({ name: 'storage', version: '1.0.0', stores: [{ id: 'mem', store }] })], store: 'mem', clock, ids: sequentialIds() });
    const result = await ai.agent({ name: 'helper', model: 'fake:m' }).task({ task: 'x' });
    await ai.close();
    expect(await store.get('runs', result.runId)).toBeDefined();
    expect(() => createAigent({ store: 'missing' })).toThrow("Unknown store 'missing'; plugin stores: (none)");
  });

  it('fires hooks in order with frozen copies, before done', async () => {
    const seen: string[] = [];
    const calls: ToolCallInfo[] = [];
    const hooks: PluginHooks = {
      onRunStart: info => { seen.push(`start:${info.agentName}:${info.model}:${info.mode}`); },
      onToolCall: info => { calls.push(info); seen.push(`call:${info.tool}`); },
      onToolResult: info => { seen.push(`result:${info.callId}:${String(info.envelope.ok)}`); },
      onRunEnd: info => { seen.push(`end:${info.status}:${info.usage.toolCalls}`); },
    };
    const provider = createFakeProvider({ turns: [toolTurn([{ id: 'c1', name: 'shout', args: { text: 'hi' } }]), textTurn('HI')] });
    const ai = createAigent({ providers: [provider], plugins: [definePlugin({ name: 'observer', version: '1.0.0', hooks })], clock, ids: sequentialIds() });
    const run = ai.agent({ name: 'helper', model: 'fake:m', tools: [shout], enableFeedback: false }).task({ task: 'x' });
    const events = await collect(run);
    expect(seen).toEqual(['start:helper:fake:m:task', 'call:shout', 'result:c1:true', 'end:completed:1']);
    expect(Object.isFrozen(calls[0]?.args)).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
    expect(warnings(events)).toEqual([]);
  });

  it('turns throwing and mutating hooks into warnings without changing the run', async () => {
    const hooks: PluginHooks = {
      onToolCall: info => { (info.args as { text: string }).text = 'changed'; },
      onRunEnd: () => { throw new Error('observer crashed'); },
    };
    const provider = createFakeProvider({ turns: [toolTurn([{ id: 'c1', name: 'shout', args: { text: 'hi' } }]), textTurn('done')] });
    const ai = createAigent({ providers: [provider], plugins: [definePlugin({ name: 'bad-observer', version: '1.0.0', hooks })], clock, ids: sequentialIds() });
    const run = ai.agent({ name: 'helper', model: 'fake:m', tools: [shout], enableFeedback: false }).task({ task: 'x' });
    const events = await collect(run);
    const result = await run;
    expect(result.status).toBe('completed');
    expect(events.find(event => event.type === 'tool-result')).toMatchObject({ envelope: { ok: true, result: 'HI' } });
    expect(warnings(events)).toEqual([
      expect.stringMatching(/^Plugin 'bad-observer' hook onToolCall failed: .*read only/i),
      "Plugin 'bad-observer' hook onRunEnd failed: observer crashed",
    ]);
  });

  it('completes the run when a hook hangs, with a timeout warning', async () => {
    const provider = createFakeProvider({ turns: [textTurn('fine')] });
    const ai = createAigent({ providers: [provider], plugins: [definePlugin({ name: 'hanger', version: '1.0.0', hooks: { onRunStart: () => new Promise<void>(() => undefined) } })], clock, ids: sequentialIds() });
    const run = ai.agent({ name: 'helper', model: 'fake:m' }).task({ task: 'x' });
    const events = await collect(run);
    expect((await run).status).toBe('completed');
    expect(warnings(events)).toEqual(["Plugin 'hanger' hook onRunStart did not finish within 1000 ms; the run continued without it"]);
  });

  it('delays done by a bounded amount when every hook of a plugin hangs, however many calls the run makes', async () => {
    const hang = (): Promise<void> => new Promise<void>(() => undefined);
    const turns = [toolTurn([{ id: 'c1', name: 'shout', args: { text: 'a' } }, { id: 'c2', name: 'shout', args: { text: 'b' } }, { id: 'c3', name: 'shout', args: { text: 'c' } }]), textTurn('done')];
    const ai = createAigent({
      providers: [createFakeProvider({ turns })],
      plugins: [definePlugin({ name: 'hanger', version: '1.0.0', hooks: { onToolCall: hang, onToolResult: hang, onRunEnd: hang } })], clock, ids: sequentialIds(),
    });
    const started = Date.now();
    const run = ai.agent({ name: 'helper', model: 'fake:m', tools: [shout], enableFeedback: false }).task({ task: 'x' });
    const events = await collect(run);
    expect((await run).status).toBe('completed');
    // One hook timeout (1000 ms) at most once per plugin, never once per event (which took over 8 s).
    expect(Date.now() - started).toBeLessThan(2_600);
    expect(warnings(events)).toEqual(["Plugin 'hanger' hook onToolCall did not finish within 1000 ms; the run continued without it"]);
  });

  it('reports run errors to onError', async () => {
    const errors: string[] = [];
    const provider = createFakeProvider({ turns: [] });
    const ai = createAigent({ providers: [provider], plugins: [definePlugin({ name: 'errors', version: '1.0.0', hooks: { onError: ({ message }) => { errors.push(message); } } })], clock, ids: sequentialIds() });
    const result = await ai.agent({ name: 'helper', model: 'fake:m' }).task({ task: 'x' });
    expect(result.status).toBe('failed');
    expect(errors).toEqual([result.failure]);
  });

  it('refuses a mutating plugin unless allowed', () => {
    const plugin = definePlugin({ name: 'rewriter', version: '1.0.0', mutating: true });
    expect(() => createAigent({ plugins: [plugin] })).toThrow("Plugin 'rewriter' declares mutating hooks");
    expect(() => createAigent({ plugins: [plugin], allowMutatingPlugins: ['rewriter'] })).not.toThrow();
  });

  it('runs setups on ai.ready() and closes plugins on ai.close()', async () => {
    const lifecycle: string[] = [];
    const plugin = definePlugin({
      name: 'lifecycle', version: '1.0.0',
      setup: async () => { lifecycle.push('setup'); return { tools: [shout] }; },
      close: async () => { lifecycle.push('close'); },
    });
    const ai = createAigent({ providers: [createFakeProvider({ turns: [] })], plugins: [plugin] });
    expect(() => ai.agent({ name: 'a', model: 'fake:m', tools: [pluginTools('lifecycle')] })).toThrow('is not ready yet');
    await ai.ready();
    expect(ai.agent({ name: 'a', model: 'fake:m', tools: [pluginTools('lifecycle')] }).name).toBe('a');
    await ai.close();
    expect(lifecycle).toEqual(['setup', 'close']);
  });
});
