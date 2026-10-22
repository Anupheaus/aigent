import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { definePlugin } from './define-plugin.js';
import type { Plugin } from './plugin-types.js';

function echoTool(name: string) {
  return defineTool({
    name, description: 'Echo', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false,
    describeActivity: () => ({ title: 'Echo' }), run: async ({ text }) => text,
  });
}

function invalidMessage(plugin: unknown): string {
  try {
    definePlugin(plugin as Plugin);
  } catch (error) {
    expect(error).toMatchObject({ code: 'invalid_definition' });
    return (error as Error).message;
  }
  throw new Error('expected definePlugin to throw');
}

describe('definePlugin', () => {
  it('returns a valid plugin unchanged in content', () => {
    const provider = createFakeProvider({ id: 'fake', turns: [] });
    const store = createInMemoryStore();
    const plugin = definePlugin({ name: 'my-plugin', version: '1.2.3', providers: [provider], tools: [echoTool('echo')], stores: [{ id: 'mem', store }], hooks: { onRunStart: () => undefined } });
    expect(plugin.name).toBe('my-plugin');
    expect(plugin.providers).toEqual([provider]);
    expect(plugin.tools?.map(({ name }) => name)).toEqual(['echo']);
    expect(plugin.stores?.[0]?.store).toBe(store);
  });

  it.each([
    ['1.0.0'], ['0.0.1'], ['10.20.30'], ['1.0.0-beta.1'], ['1.0.0+build.5'], ['2.1.0-rc.1+sha.abc'],
  ])('accepts version %s', version => {
    expect(definePlugin({ name: 'p', version }).version).toBe(version);
  });

  it.each([
    [{ name: 'My Plugin', version: '1.0.0' }, "name: Plugin name must be kebab-case"],
    [{ name: 'my_plugin', version: '1.0.0' }, 'name: Plugin name must be kebab-case'],
    [{ name: '-p', version: '1.0.0' }, 'name: Plugin name must be kebab-case'],
    [{ name: 'p', version: 'v1' }, 'version: Plugin version must be semver-style'],
    [{ name: 'p', version: '1.0' }, 'version: Plugin version must be semver-style'],
    [{ name: 'p', version: '1.0.0', extra: true }, 'Unrecognized key'],
    [{ name: 'p', version: '1.0.0', hooks: { onStart: () => undefined } }, 'hooks: Unrecognized key'],
    [{ name: 'p', version: '1.0.0', hooks: { onRunStart: 'x' } }, 'hooks.onRunStart: must be a function'],
    [{ name: 'p', version: '1.0.0', providers: [{ id: 'x' }] }, 'providers.0'],
    [{ name: 'p', version: '1.0.0', tools: [{ name: 'x' }] }, 'tools.0'],
    [{ name: 'p', version: '1.0.0', stores: [{ id: '', store: createInMemoryStore() }] }, 'stores.0.id'],
    [{ name: 'p', version: '1.0.0', stores: [{ id: 's', store: {} }] }, 'stores.0.store'],
    [{ name: 'p', version: '1.0.0', mutating: 'yes' }, 'mutating'],
  ])('rejects %j', (plugin, fragment) => {
    expect(invalidMessage(plugin)).toContain(fragment);
  });

  it('names the plugin in its error message', () => {
    expect(invalidMessage({ name: 'p', version: 'x' })).toMatch(/^Plugin 'p' is invalid: /);
  });

  it('rejects duplicate provider ids, tool names and store ids inside one plugin, naming them', () => {
    const fake = createFakeProvider({ id: 'fake', turns: [] });
    expect(invalidMessage({ name: 'p', version: '1.0.0', providers: [fake, createFakeProvider({ id: 'fake', turns: [] })] })).toContain("Plugin 'p' declares provider id 'fake' twice");
    expect(invalidMessage({ name: 'p', version: '1.0.0', tools: [echoTool('echo'), echoTool('echo')] })).toContain("Plugin 'p' declares tool 'echo' twice");
    const store = createInMemoryStore();
    expect(invalidMessage({ name: 'p', version: '1.0.0', stores: [{ id: 's', store }, { id: 's', store }] })).toContain("Plugin 'p' declares store id 's' twice");
  });
  it('refuses a provider id with a colon, which could never be selected as <provider id>:<model>', () => {
    expect(invalidMessage({ name: 'colon', version: '1.0.0', providers: [createFakeProvider({ id: 'my:provider', turns: [] })] }))
      .toContain("provider id must not contain ':'");
  });
});
