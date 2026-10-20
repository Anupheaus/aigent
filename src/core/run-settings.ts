import type { PromptCompressionContext } from '../compression/compress-prompt.js';
import { resolveContextBudget } from '../context/context-budget.js';
import { filterProviderSettings } from './filter-provider-settings.js';
import type { ModelSettings } from './model-settings.js';
import type { ProviderTarget, TurnRouting } from './open-turn-stream.js';
import { resolveModelSettings } from './resolve-model-settings.js';
import type { RunCompactionSettings } from './run-compaction.js';
import type { ModelTarget, ResolvedAgent, RuntimeServices } from './start-task-run.js';
import type { TaskInput } from './task-input.js';

export interface ProviderTargetParams {
  target: ModelTarget;
  agent: ResolvedAgent;
  input: TaskInput;
}

/** Resolves the run's settings for one model (its provider's layer differs) and filters them for that provider. */
export function toProviderTarget(params: ProviderTargetParams): ProviderTarget {
  const { target: { reference, provider, model, providerSettings }, agent: { agentSettings, runtimeSettings }, input } = params;
  const settings = resolveModelSettings({ task: input.modelSettings, agent: agentSettings, runtime: runtimeSettings, provider: providerSettings });
  const filtered = filterProviderSettings({ provider, model, settings });
  const { warnings, dropped } = filtered;
  return { label: reference, provider, model, warnings, dropped, ...(filtered.settings == null ? {} : { settings: filtered.settings }) };
}

/** How a run (or a preview) compresses prompt text: the agent's settings over the runtime's shared cache. */
export function promptCompressionContext(params: { agent: ResolvedAgent; services: RuntimeServices }): PromptCompressionContext {
  const { agent: { compression }, services: { compressionCache, clock } } = params;
  return { cache: compressionCache, now: () => clock.now(), ...(compression == null ? {} : { compression }) };
}

export interface CompactionSettingsParams {
  agent: ResolvedAgent;
  input: TaskInput;
  routing: TurnRouting;
  /** The run's resolved settings (`contextSize` and `maxOutputTokens` size the budget). */
  settings: ModelSettings;
}

/** The run's usable budget (from the primary model) and its summariser: `compactionModel`, else the run's own models. */
export function compactionSettings(params: CompactionSettingsParams): RunCompactionSettings {
  const { agent, input, routing, settings: { contextSize, maxOutputTokens } } = params;
  const { compaction: policy, compactionTarget, targets: [{ provider }] } = agent;
  const { usable } = resolveContextBudget({ maxContextTokens: provider.capabilities.maxContextTokens, ...(contextSize == null ? {} : { contextSize }), ...(maxOutputTokens == null ? {} : { maxOutputTokens }) });
  const summariser: TurnRouting = compactionTarget == null ? routing : { ...routing, targets: [toProviderTarget({ target: compactionTarget, agent, input })] };
  return { policy, usableBudget: usable, summariser };
}
