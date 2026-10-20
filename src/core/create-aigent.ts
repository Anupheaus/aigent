import type { Provider } from '../providers/provider-types.js';
import type { Store } from '../store/store-types.js';
import { createWriteQueue } from '../store/write-queue.js';
import { createMultiTool } from '../tools/multi-tool.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import { createAigentError } from './aigent-error.js';
import type { Agent, AgentDefinition, TaskRun } from './agent-types.js';
import { computeAgentVersion } from './agent-version.js';
import { LIBRARY_VERSION } from './library-version.js';
import { parseModelReference } from './model-reference.js';
import { parseModelSettings } from './model-settings.js';
import type { ModelSettings } from './model-settings.js';
import { resolveModelSettings } from './resolve-model-settings.js';
import { createSystemClock, createUuidGenerator } from './runtime-services.js';
import type { Clock, IdGenerator } from './runtime-services.js';
import { startTaskRun } from './start-task-run.js';
import type { ModelTarget, RuntimeServices } from './start-task-run.js';
import { parseAgentLimits, parseTaskInput } from './task-input.js';

export interface AigentOptions {
  /** Every provider agents may use; ids must be unique. */
  providers: Provider[];
  /** Where run records are written; nothing is persisted without one. */
  store?: Store;
  clock?: Clock;
  ids?: IdGenerator;
  /** Runtime-wide model settings; agent and task settings win over them, field by field. */
  modelSettings?: ModelSettings;
  /** Per-provider default settings, keyed by provider id; the lowest-precedence layer. */
  providerModelSettings?: Record<string, ModelSettings>;
}

export interface Aigent {
  /** Validates the definition (throws `invalid_definition` / `unknown_provider`) and returns the agent. */
  agent(definition: AgentDefinition): Agent;
  /**
   * Resolves once every run started so far (and any started while closing) has settled and every pending store
   * write has been flushed, so run records are not lost on shutdown. It does not stop runs; stop them first to close quickly.
   */
  close(): Promise<void>;
}

function indexProviders(providers: Provider[]): Map<string, Provider> {
  const byId = new Map<string, Provider>();
  for (const provider of providers) {
    if (byId.has(provider.id)) {
      throw createAigentError({ code: 'invalid_definition', message: `Duplicate provider id '${provider.id}'; each provider must have a unique id`, details: { providerId: provider.id } });
    }
    byId.set(provider.id, provider);
  }
  return byId;
}

function unknownProviderError(params: { providerId: string; providersById: Map<string, Provider> }): Error {
  const { providerId, providersById } = params;
  const knownIds = [...providersById.keys()].join(', ') || '(none)';
  return createAigentError({ code: 'unknown_provider', message: `Unknown provider '${providerId}'; known providers: ${knownIds}`, details: { providerId } });
}

/** Validates every per-provider settings layer up front, so a typo fails at `createAigent`, not on a later task. */
function parseProviderModelSettings(params: { settings: Record<string, ModelSettings> | undefined; providersById: Map<string, Provider> }): Map<string, ModelSettings> {
  const { settings = {}, providersById } = params;
  return new Map(Object.entries(settings).map(([providerId, providerSettings]) => {
    if (!providersById.has(providerId)) throw unknownProviderError({ providerId, providersById });
    return [providerId, parseModelSettings({ owner: `Provider '${providerId}'`, settings: providerSettings }) ?? {}];
  }));
}

export function createAigent(options: AigentOptions): Aigent {
  const { providers, store, clock = createSystemClock(), ids = createUuidGenerator() } = options;
  const providersById = indexProviders(providers);
  const runtimeSettings = parseModelSettings({ owner: 'createAigent', settings: options.modelSettings });
  const providerSettingsById = parseProviderModelSettings({ settings: options.providerModelSettings, providersById });
  const services: RuntimeServices = { clock, ids, store, writeQueue: createWriteQueue() };
  /** Settles (never rejects) when its run has finished, including writing its record. */
  const activeRuns = new Set<Promise<void>>();

  function track(run: TaskRun): TaskRun {
    const settled = Promise.resolve(run).then(() => undefined, () => undefined);
    activeRuns.add(settled);
    void settled.then(() => activeRuns.delete(settled));
    return run;
  }

  async function close(): Promise<void> {
    // Loop because a run may be started while we wait for the earlier ones.
    while (activeRuns.size > 0) await Promise.all([...activeRuns]);
    await services.writeQueue.flush();
  }

  function resolveTarget(reference: string): ModelTarget {
    const { providerId, model } = parseModelReference(reference);
    const provider = providersById.get(providerId);
    if (provider == null) throw unknownProviderError({ providerId, providersById });
    const providerSettings = providerSettingsById.get(providerId);
    return { reference, provider, model, ...(providerSettings == null ? {} : { providerSettings }) };
  }

  function agent(definition: AgentDefinition): Agent {
    const { name, persona, skillset, context, tools = [], version } = definition;
    if (name === '') throw createAigentError({ code: 'invalid_definition', message: 'Agent name must be a non-empty string' });
    const limits = parseAgentLimits({ agentName: name, limits: definition.limits });
    const agentSettings = parseModelSettings({ owner: `Agent '${name}'`, settings: definition.modelSettings });
    const target = resolveTarget(definition.model);
    const instanceId = definition.instanceId ?? ids.next('agent');
    // The multi tool only reaches user tools; registering it alongside them makes a user tool named aigent_multi a duplicate.
    const registry = createToolRegistry([...tools, createMultiTool({ registry: createToolRegistry(tools), now: () => clock.now() })]);
    const effectiveSettings = resolveModelSettings({ agent: agentSettings, runtime: runtimeSettings, provider: target.providerSettings });
    const agentVersion = computeAgentVersion({ libraryVersion: LIBRARY_VERSION, model: target.reference, persona, skillset, context, modelSettings: effectiveSettings, limits, version, tools });
    const resolved = { name, instanceId, target, prompt: { persona, skillset, context }, registry, limits, agentSettings, runtimeSettings, agentVersion, version };
    return {
      name,
      instanceId,
      agentVersion,
      task: rawInput => track(startTaskRun({ agent: resolved, services, input: parseTaskInput(rawInput) })),
    };
  }

  return { agent, close };
}
