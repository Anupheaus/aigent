import { createAigentError } from '../core/aigent-error.js';
import { describeError } from '../core/describe-value.js';
import type { Provider } from '../providers/provider-types.js';
import type { Store } from '../store/store-types.js';
import type { Tool } from '../tools/tool-types.js';
import { definePlugin, rejectDuplicateTools } from './define-plugin.js';
import { isPluginToolsRef } from './plugin-tools.js';
import type { Plugin, PluginToolsRef } from './plugin-types.js';
import type { RegisteredHooks } from './run-hooks.js';

/** Where a provider came from, for collision messages. */
const DIRECT_PROVIDERS_SOURCE = 'createAigent({ providers })';

export interface CreatePluginRegistryParams {
  /** `createAigent({ providers })`. */
  providers: Provider[];
  /** `createAigent({ allowMutatingPlugins })`: the only plugins that may declare `mutating: true`. */
  allowMutatingPlugins?: string[];
}

export interface PluginRegistry {
  /** Every provider by id (direct ones first); live, so plugins added later resolve too. */
  readonly providers: ReadonlyMap<string, Provider>;
  /** Validates and registers a plugin; throws `invalid_definition` (and registers nothing) on any conflict, `invalid_input` after close. */
  add(plugin: Plugin): void;
  /** A plugin store by id; throws `invalid_definition` for an unknown id. */
  store(id: string): Store;
  /** An agent's tools with every `pluginTools` reference replaced by that plugin's tools. */
  expandTools(entries: (Tool | PluginToolsRef)[]): Tool[];
  /** Plugins with hooks, in registration order. */
  hooks(): RegisteredHooks[];
  /** Runs every plugin's `setup` once (added plugins too); rejects with the first failure, or `invalid_input` after close. */
  ready(): Promise<void>;
  /** Waits for setups in flight, then calls every plugin's `close` once, all of them even when one fails; rejects with the first failure. */
  close(): Promise<void>;
}

interface PluginEntry {
  plugin: Plugin;
  /** Static tools, then those `setup` found; undefined while a `setup` has not finished. */
  tools?: Tool[];
  setup?: Promise<void>;
}

function invalid(message: string, details: Record<string, unknown>): Error {
  return createAigentError({ code: 'invalid_definition', message, details });
}

/** What `ai.use`/`ai.ready` answer once the runtime is closed: nothing started then would ever be released. */
function closedError(action: string): Error {
  return createAigentError({ code: 'invalid_input', message: `${action}: the runtime is closed; create a new one with createAigent()`, details: { action } });
}

function sourceLabel(source: string | undefined): string {
  return source == null ? DIRECT_PROVIDERS_SOURCE : `plugin '${source}'`;
}

/** The runtime's plugins: their providers, stores, tools, hooks and lifecycle. */
export function createPluginRegistry(params: CreatePluginRegistryParams): PluginRegistry {
  const { allowMutatingPlugins = [] } = params;
  const providers = new Map<string, Provider>();
  /** Plugin name per provider id; absent for direct providers. */
  const providerSources = new Map<string, string>();
  const stores = new Map<string, { store: Store; plugin: string }>();
  const entries = new Map<string, PluginEntry>();
  let closing: Promise<void> | undefined;
  for (const provider of params.providers) {
    if (providers.has(provider.id)) throw invalid(`Duplicate provider id '${provider.id}'; each provider must have a unique id`, { providerId: provider.id });
    providers.set(provider.id, provider);
  }

  /** Every conflict is found before anything is registered, so a rejected plugin leaves no trace. */
  function checkConflicts(plugin: Plugin): void {
    const { name, providers: pluginProviders = [], stores: pluginStores = [], mutating } = plugin;
    const existing = entries.get(name);
    if (existing != null) throw invalid(`Plugin '${name}' is already registered (version ${existing.plugin.version}); plugin names must be unique`, { plugin: name });
    if (mutating === true && !allowMutatingPlugins.includes(name)) {
      throw invalid(`Plugin '${name}' declares mutating hooks; allow it explicitly with createAigent({ allowMutatingPlugins: ['${name}'] })`, { plugin: name });
    }
    for (const { id } of pluginProviders) {
      if (!providers.has(id)) continue;
      throw invalid(`Provider id '${id}' from plugin '${name}' collides with provider '${id}' from ${sourceLabel(providerSources.get(id))}; provider ids must be unique`, { providerId: id, plugin: name });
    }
    for (const { id } of pluginStores) {
      const taken = stores.get(id);
      if (taken != null) throw invalid(`Store id '${id}' from plugin '${name}' collides with the store from plugin '${taken.plugin}'; store ids must be unique`, { storeId: id, plugin: name });
    }
  }

  function add(raw: Plugin): void {
    if (closing != null) throw closedError(`ai.use('${raw.name}')`);
    const plugin = definePlugin(raw);
    checkConflicts(plugin);
    const { name, providers: pluginProviders = [], stores: pluginStores = [], tools = [] } = plugin;
    for (const provider of pluginProviders) {
      providers.set(provider.id, provider);
      providerSources.set(provider.id, name);
    }
    for (const { id, store } of pluginStores) stores.set(id, { store, plugin: name });
    entries.set(name, { plugin, ...(plugin.setup == null ? { tools: [...tools] } : {}) });
  }

  function store(id: string): Store {
    const found = stores.get(id);
    if (found == null) throw invalid(`Unknown store '${id}'; plugin stores: ${[...stores.keys()].join(', ') || '(none)'}`, { storeId: id });
    return found.store;
  }

  function toolsOf(name: string): Tool[] {
    const entry = entries.get(name);
    if (entry == null) throw invalid(`pluginTools('${name}'): no plugin named '${name}'; registered plugins: ${[...entries.keys()].join(', ') || '(none)'}`, { plugin: name });
    if (entry.tools == null) throw invalid(`pluginTools('${name}'): plugin '${name}' is not ready yet; await ai.ready() before defining agents that use its tools`, { plugin: name });
    return entry.tools;
  }

  function setUp(entry: PluginEntry): Promise<void> {
    const { plugin } = entry;
    entry.setup ??= (async () => {
      let found: Tool[];
      try {
        found = (await plugin.setup?.())?.tools ?? [];
      } catch (error) {
        throw createAigentError({ code: 'invalid_definition', message: `Plugin '${plugin.name}' failed to set up: ${describeError(error)}`, details: { plugin: plugin.name } });
      }
      const tools = [...plugin.tools ?? [], ...found];
      rejectDuplicateTools({ plugin: plugin.name, tools });
      entry.tools = tools;
    })();
    return entry.setup;
  }

  async function ready(): Promise<void> {
    if (closing != null) throw closedError('ai.ready()');
    await Promise.all([...entries.values()].map(setUp));
  }

  function close(): Promise<void> {
    // Only the first call reports a failure; later calls wait for the same work, so plugins are closed once.
    if (closing != null) return closing.catch(() => undefined);
    closing = (async () => {
      // A setup still running would otherwise finish after close and leave what it started (e.g. a server process) behind.
      await Promise.allSettled([...entries.values()].map(({ setup }) => setup));
      const closed = await Promise.allSettled([...entries.values()].map(async ({ plugin }) => plugin.close?.()));
      const failed = closed.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      if (failed != null) throw failed.reason;
    })();
    return closing;
  }

  return {
    providers,
    add,
    store,
    expandTools: list => list.flatMap(entry => (isPluginToolsRef(entry) ? toolsOf(entry.plugin) : [entry])),
    hooks: () => [...entries.values()].flatMap(({ plugin: { name, hooks } }) => (hooks == null ? [] : [{ plugin: name, hooks }])),
    ready,
    close,
  };
}
