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

/** Output tokens a summary may use; the summariser is asked for well under this (see `SUMMARISER_PROMPT`). */
export const SUMMARY_MAX_OUTPUT_TOKENS = 1_024;

/** The summariser gets the run's sampling settings but none that would cut it short or lengthen it oddly. */
function asSummariserTarget(target: ProviderTarget): ProviderTarget {
  const { stop: _stop, seed: _seed, thinking: _thinking, ...kept } = target.settings ?? {};
  return { ...target, settings: { ...kept, maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS } };
}

/**
 * The run's usable budget (from the smallest window of its models, fallbacks included, so a fallback is never sent an
 * oversized request), its summariser (`compactionModel`, else the run's own models, with bounded settings) and the
 * prompt budget of the summariser's first model.
 */
export function compactionSettings(params: CompactionSettingsParams): RunCompactionSettings {
  const { agent, input, routing, settings: { contextSize, maxOutputTokens } } = params;
  const { compaction: policy, compactionTarget, targets } = agent;
  const usableBudget = Math.min(...targets.map(({ provider }) => resolveContextBudget({ maxContextTokens: provider.capabilities.maxContextTokens, ...(contextSize == null ? {} : { contextSize }), ...(maxOutputTokens == null ? {} : { maxOutputTokens }) }).usable));
  const [first, ...rest]: TurnRouting['targets'] = compactionTarget == null ? routing.targets : [toProviderTarget({ target: compactionTarget, agent, input })];
  const summariser: TurnRouting = { ...routing, targets: [asSummariserTarget(first), ...rest.map(asSummariserTarget)] };
  const summariserProvider = compactionTarget?.provider ?? targets[0].provider;
  const summariserBudget = resolveContextBudget({ maxContextTokens: summariserProvider.capabilities.maxContextTokens, ...(compactionTarget == null && contextSize != null ? { contextSize } : {}), maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS }).usable;
  return { policy, usableBudget, summariser, summariserBudget };
}
