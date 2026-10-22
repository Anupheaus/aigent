import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { definePlugin } from './define-plugin.js';
import { createPluginRegistry } from './plugin-registry.js';
import { pluginTools } from './plugin-tools.js';

function tool(name: string) {
  return defineTool({
    name, description: 'Echo', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false,
    describeActivity: () => ({ title: 'Echo' }), run: async ({ text }) => text,
  });
}

function thrown(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected an error');
}

describe('createPluginRegistry', () => {
  it('indexes direct providers and plugin providers by their own ids', () => {
    const direct = createFakeProvider({ id: 'fake', turns: [] });
    const fromPlugin = createFakeProvider({ id: 'other', turns: [] });
    const registry = createPluginRegistry({ providers: [direct] });
    registry.add(definePlugin({ name: 'extra', version: '1.0.0', providers: [fromPlugin] }));
    expect([...registry.providers.keys()]).toEqual(['fake', 'other']);
    expect(registry.providers.get('other')).toBe(fromPlugin);
  });

  it('rejects duplicate direct provider ids', () => {
    const error = thrown(() => createPluginRegistry({ providers: [createFakeProvider({ turns: [] }), createFakeProvider({ turns: [] })] }));
    expect(error).toMatchObject({ code: 'invalid_definition', message: expect.stringContaining("Duplicate provider id 'fake'") });
  });

  it('rejects a plugin provider whose id collides, naming both sources', () => {
    const registry = createPluginRegistry({ providers: [createFakeProvider({ turns: [] })] });
    const error = thrown(() => registry.add(definePlugin({ name: 'clash', version: '1.0.0', providers: [createFakeProvider({ turns: [] })] })));
    expect(error).toMatchObject({ code: 'invalid_definition', details: { providerId: 'fake' } });
    expect(error.message).toBe("Provider id 'fake' from plugin 'clash' collides with provider 'fake' from createAigent({ providers }); provider ids must be unique");
    registry.add(definePlugin({ name: 'first', version: '1.0.0', providers: [createFakeProvider({ id: 'p2', turns: [] })] }));
    const second = thrown(() => registry.add(definePlugin({ name: 'second', version: '1.0.0', providers: [createFakeProvider({ id: 'p2', turns: [] })] })));
    expect(second.message).toBe("Provider id 'p2' from plugin 'second' collides with provider 'p2' from plugin 'first'; provider ids must be unique");
  });

  it('rejects a second plugin with the same name and leaves the registry unchanged on any rejection', () => {
    const registry = createPluginRegistry({ providers: [] });
    registry.add(definePlugin({ name: 'p', version: '1.0.0' }));
    expect(thrown(() => registry.add(definePlugin({ name: 'p', version: '2.0.0' }))).message).toBe("Plugin 'p' is already registered (version 1.0.0); plugin names must be unique");
    const store = createInMemoryStore();
    registry.add(definePlugin({ name: 'stores-a', version: '1.0.0', stores: [{ id: 's', store }] }));
    expect(thrown(() => registry.add(definePlugin({ name: 'stores-b', version: '1.0.0', providers: [createFakeProvider({ id: 'new', turns: [] })], stores: [{ id: 's', store }] }))).message)
      .toBe("Store id 's' from plugin 'stores-b' collides with the store from plugin 'stores-a'; store ids must be unique");
    // The rejected plugin's provider was not registered.
    expect(registry.providers.has('new')).toBe(false);
  });

  it('validates plugins that were not made with definePlugin', () => {
    const registry = createPluginRegistry({ providers: [] });
    expect(thrown(() => registry.add({ name: 'Bad Name', version: '1.0.0' }))).toMatchObject({ code: 'invalid_definition' });
  });

  it('refuses a mutating plugin unless the runtime allows it by name', () => {
    const plugin = definePlugin({ name: 'rewriter', version: '1.0.0', mutating: true, hooks: { onToolCall: () => undefined } });
    expect(thrown(() => createPluginRegistry({ providers: [] }).add(plugin)).message)
      .toBe("Plugin 'rewriter' declares mutating hooks; allow it explicitly with createAigent({ allowMutatingPlugins: ['rewriter'] })");
    expect(() => createPluginRegistry({ providers: [], allowMutatingPlugins: ['rewriter'] }).add(plugin)).not.toThrow();
  });

  it('resolves a plugin store by id and rejects an unknown one, listing the known ids', () => {
    const store = createInMemoryStore();
    const registry = createPluginRegistry({ providers: [] });
    registry.add(definePlugin({ name: 'storage', version: '1.0.0', stores: [{ id: 'disk', store }] }));
    expect(registry.store('disk')).toBe(store);
    expect(thrown(() => registry.store('nope')).message).toBe("Unknown store 'nope'; plugin stores: disk");
  });

  it('expands pluginTools references and keeps plain tools in place', () => {
    const registry = createPluginRegistry({ providers: [] });
    registry.add(definePlugin({ name: 'pack', version: '1.0.0', tools: [tool('one'), tool('two')] }));
    const own = tool('mine');
    expect(registry.expandTools([own, pluginTools('pack')]).map(({ name }) => name)).toEqual(['mine', 'one', 'two']);
    expect(thrown(() => registry.expandTools([pluginTools('missing')])).message).toBe("pluginTools('missing'): no plugin named 'missing'; registered plugins: pack");
  });

  it('adds the tools a setup finds once ready, and refuses its tools before then', async () => {
    const registry = createPluginRegistry({ providers: [] });
    const setup = vi.fn(async () => ({ tools: [tool('found')] }));
    registry.add(definePlugin({ name: 'lazy', version: '1.0.0', tools: [tool('static')], setup }));
    expect(setup).not.toHaveBeenCalled();
    expect(thrown(() => registry.expandTools([pluginTools('lazy')])).message).toBe("pluginTools('lazy'): plugin 'lazy' is not ready yet; await ai.ready() before defining agents that use its tools");
    await Promise.all([registry.ready(), registry.ready()]);
    expect(setup).toHaveBeenCalledTimes(1);
    expect(registry.expandTools([pluginTools('lazy')]).map(({ name }) => name)).toEqual(['static', 'found']);
  });

  it('rejects ready() when a setup fails or finds a duplicate tool, naming the plugin', async () => {
    const failing = createPluginRegistry({ providers: [] });
    failing.add(definePlugin({ name: 'broken', version: '1.0.0', setup: async () => { throw new Error('no server'); } }));
    await expect(failing.ready()).rejects.toThrow("Plugin 'broken' failed to set up: no server");
    const duplicate = createPluginRegistry({ providers: [] });
    duplicate.add(definePlugin({ name: 'dup', version: '1.0.0', tools: [tool('same')], setup: async () => ({ tools: [tool('same')] }) }));
    await expect(duplicate.ready()).rejects.toThrow("Plugin 'dup' declares tool 'same' twice");
  });

  it('lists hooks in registration order and closes every plugin once, even when one fails', async () => {
    const registry = createPluginRegistry({ providers: [] });
    const closeA = vi.fn(async () => { throw new Error('a failed'); });
    const closeB = vi.fn(async () => undefined);
    const onRunStart = (): void => undefined;
    registry.add(definePlugin({ name: 'a', version: '1.0.0', close: closeA, hooks: { onRunStart } }));
    registry.add(definePlugin({ name: 'b', version: '1.0.0', close: closeB }));
    expect(registry.hooks()).toEqual([{ plugin: 'a', hooks: { onRunStart } }]);
    await expect(registry.close()).rejects.toThrow('a failed');
    await registry.close();
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
  });
  it('refuses ready() and add() after close, so nothing is started or registered that close would never release', async () => {
    const registry = createPluginRegistry({ providers: [] });
    const setup = vi.fn(async () => ({ tools: [] }));
    registry.add(definePlugin({ name: 'late-setup', version: '1.0.0', setup }));
    await registry.close();
    await expect(registry.ready()).rejects.toMatchObject({ code: 'invalid_input', message: 'ai.ready(): the runtime is closed; create a new one with createAigent()' });
    expect(setup).not.toHaveBeenCalled();
    expect(thrown(() => registry.add(definePlugin({ name: 'after-close', version: '1.0.0' })))).toMatchObject({
      code: 'invalid_input', message: "ai.use('after-close'): the runtime is closed; create a new one with createAigent()",
    });
    expect(registry.hooks()).toEqual([]);
  });

  it('closes a plugin only after its in-flight setup settled, so close releases what setup started', async () => {
    const registry = createPluginRegistry({ providers: [] });
    const order: string[] = [];
    let finishSetup: () => void = () => undefined;
    registry.add(definePlugin({
      name: 'slow-setup', version: '1.0.0',
      setup: () => new Promise<void>(resolve => { finishSetup = () => { order.push('setup done'); resolve(); }; }),
      close: async () => { order.push('close'); },
    }));
    const ready = registry.ready();
    const closed = registry.close();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    finishSetup();
    await Promise.all([ready, closed]);
    expect(order).toEqual(['setup done', 'close']);
  });
  it('names both sources when an agent gets the same tool name from two plugins or a plugin and its own tools', () => {
    const registry = createPluginRegistry({ providers: [] });
    registry.add(definePlugin({ name: 'pack-a', version: '1.0.0', tools: [tool('read')] }));
    registry.add(definePlugin({ name: 'pack-b', version: '1.0.0', tools: [tool('read')] }));
    expect(thrown(() => registry.expandTools([pluginTools('pack-a'), pluginTools('pack-b')]))).toMatchObject({
      code: 'invalid_definition', message: "Tool 'read' from plugin 'pack-b' collides with tool 'read' from plugin 'pack-a'; tool names must be unique within an agent",
    });
    expect(thrown(() => registry.expandTools([tool('read'), pluginTools('pack-a')])).message)
      .toBe("Tool 'read' from plugin 'pack-a' collides with tool 'read' from the agent's own tools; tool names must be unique within an agent");
  });

  it('says a plugin failed to set up, not that it is not ready, once its setup failed', async () => {
    const registry = createPluginRegistry({ providers: [] });
    registry.add(definePlugin({ name: 'broken', version: '1.0.0', setup: async () => { throw new Error('no server'); } }));
    await expect(registry.ready()).rejects.toThrow();
    expect(thrown(() => registry.expandTools([pluginTools('broken')]))).toMatchObject({
      code: 'invalid_definition', message: "pluginTools('broken'): plugin 'broken' failed to set up (Plugin 'broken' failed to set up: no server); its tools are unavailable",
    });
  });
});
