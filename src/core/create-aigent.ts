import type { Provider } from '../providers/provider-types.js';
import type { Store } from '../store/store-types.js';
import { createWriteQueue } from '../store/write-queue.js';
import { createMultiTool } from '../tools/multi-tool.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import { createAigentError } from './aigent-error.js';
import type { Agent, AgentDefinition, TaskRun } from './agent-types.js';
import { createSystemClock, createUuidGenerator } from './runtime-services.js';
import type { Clock, IdGenerator } from './runtime-services.js';
import { startTaskRun } from './start-task-run.js';
import type { RuntimeServices } from './start-task-run.js';
import { parseAgentLimits, parseTaskInput } from './task-input.js';

export interface AigentOptions {
  /** Every provider agents may use; ids must be unique. */
  providers: Provider[];
  /** Where run records are written; nothing is persisted without one. */
  store?: Store;
  clock?: Clock;
  ids?: IdGenerator;
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

const MODEL_SEPARATOR = ':';

interface ModelReference {
  providerId: string;
  model: string;
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

/** Splits `provider:model` at the first colon, since model ids may themselves contain colons. */
function parseModelReference(modelReference: string): ModelReference {
  const separatorIndex = modelReference.indexOf(MODEL_SEPARATOR);
  const providerId = modelReference.slice(0, separatorIndex);
  const model = modelReference.slice(separatorIndex + 1);
  if (separatorIndex === -1 || providerId === '' || model === '') {
    throw createAigentError({ code: 'invalid_definition', message: `Model '${modelReference}' must be in the form provider:model, e.g. 'anthropic:claude-sonnet-5-5'`, details: { model: modelReference } });
  }
  return { providerId, model };
}

export function createAigent(options: AigentOptions): Aigent {
  const { providers, store, clock = createSystemClock(), ids = createUuidGenerator() } = options;
  const providersById = indexProviders(providers);
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

  function resolveProvider(providerId: string): Provider {
    const provider = providersById.get(providerId);
    if (provider != null) return provider;
    const knownIds = [...providersById.keys()].join(', ') || '(none)';
    throw createAigentError({ code: 'unknown_provider', message: `Unknown provider '${providerId}'; known providers: ${knownIds}`, details: { providerId } });
  }

  function agent(definition: AgentDefinition): Agent {
    const { name, persona, skillset, context, tools = [] } = definition;
    if (name === '') throw createAigentError({ code: 'invalid_definition', message: 'Agent name must be a non-empty string' });
    const limits = parseAgentLimits({ agentName: name, limits: definition.limits });
    const { providerId, model } = parseModelReference(definition.model);
    const provider = resolveProvider(providerId);
    const instanceId = definition.instanceId ?? ids.next('agent');
    // The multi tool only reaches user tools; registering it alongside them makes a user tool named aigent_multi a duplicate.
    const registry = createToolRegistry([...tools, createMultiTool({ registry: createToolRegistry(tools), now: () => clock.now() })]);
    const resolved = { name, instanceId, model, provider, prompt: { persona, skillset, context }, registry, limits };
    return {
      name,
      instanceId,
      task: rawInput => track(startTaskRun({ agent: resolved, services, input: parseTaskInput(rawInput) })),
    };
  }

  return { agent, close };
}
