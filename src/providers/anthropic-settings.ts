import { reservedOptionWarnings } from './provider-options.js';
import type { ProviderSettings, SettingsContext } from './provider-types.js';

/** Body fields the adapter sets itself; `providerOptions` cannot replace them. */
export const ANTHROPIC_RESERVED_BODY_FIELDS: readonly string[] = [
  'model', 'stream', 'system', 'messages', 'tools', 'max_tokens', 'temperature', 'top_p', 'stop_sequences', 'thinking',
];

/** `thinking` as the Messages API takes it. */
export interface AnthropicThinking {
  type: 'enabled';
  budget_tokens: number;
}

/** Messages API body fields that settings map to. */
export interface AnthropicSettingsFields {
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  thinking?: AnthropicThinking;
}

export interface AnthropicSettingsParams {
  settings: ProviderSettings;
  /** `max_tokens` when the settings have no `maxOutputTokens`. */
  defaultMaxTokens: number;
}

/** Settings this adapter maps; `seed` has no Messages API equivalent. */
export const ANTHROPIC_SUPPORTED_SETTINGS: (keyof ProviderSettings)[] = ['maxOutputTokens', 'temperature', 'topP', 'thinking', 'effort', 'promptCaching', 'stop', 'providerOptions'];

const PROVIDER_ID = 'anthropic';
/** Budget for `thinking: 'on'` when `maxOutputTokens` does not force a smaller one. */
const DEFAULT_THINKING_BUDGET = 8000;
/** The API's smallest accepted thinking budget. */
const MIN_THINKING_BUDGET = 1024;
/** Room left for the visible answer when `max_tokens` has to be raised above the thinking budget. */
const ANSWER_HEADROOM_TOKENS = 1024;
/** With thinking on, the API accepts `top_p` only from this value up to 1. */
const MIN_TOP_P_WITH_THINKING = 0.95;

const EFFORT_THINKING_BUDGET: Record<NonNullable<ProviderSettings['effort']>, number> = {
  low: 2048,
  medium: 8000,
  high: 16_000,
  max: 32_000,
};

/** `preferred`, lowered to stay below `maxOutputTokens` when that is set, but never below the API minimum. */
function fitBudget(params: { preferred: number; maxOutputTokens?: number }): number {
  const { preferred, maxOutputTokens = Number.POSITIVE_INFINITY } = params;
  return Math.max(MIN_THINKING_BUDGET, Math.min(maxOutputTokens - 1, preferred));
}

/**
 * The thinking budget the settings ask for, or undefined for no thinking. An explicit `{ budgetTokens }` is used as
 * given; `'on'` and `effort` pick a budget that fits below `maxOutputTokens`, so the user's cap holds where the API
 * minimum allows.
 */
function thinkingBudget(settings: ProviderSettings): number | undefined {
  const { thinking, effort, maxOutputTokens } = settings;
  if (thinking === 'off') return undefined;
  if (thinking === 'on') return fitBudget({ preferred: DEFAULT_THINKING_BUDGET, maxOutputTokens });
  if (thinking != null) return thinking.budgetTokens;
  return effort == null ? undefined : fitBudget({ preferred: EFFORT_THINKING_BUDGET[effort], maxOutputTokens });
}

/**
 * Supported settings the API cannot take together: while thinking, `temperature` (the API requires the default) and a
 * `topP` below 0.95; without thinking, `topP` alongside `temperature` (current models reject both); and `effort`
 * alongside an explicit `thinking`, which decides the budget instead.
 */
export function anthropicUnsupportedSettings(settings: ProviderSettings): (keyof ProviderSettings)[] {
  const { thinking, effort, temperature, topP } = settings;
  const conflicts: (keyof ProviderSettings)[] = [];
  if (thinkingBudget(settings) != null) {
    if (temperature != null) conflicts.push('temperature');
    if (topP != null && topP < MIN_TOP_P_WITH_THINKING) conflicts.push('topP');
  } else if (temperature != null && topP != null) {
    conflicts.push('topP');
  }
  if (effort != null && thinking != null) conflicts.push('effort');
  return conflicts;
}

/** `max_tokens` for these settings: raised above the thinking budget when needed, as the API requires. */
function maxTokensFor(params: { settings: ProviderSettings; requestedMaxTokens: number }): number {
  const { settings, requestedMaxTokens } = params;
  const budget = thinkingBudget(settings);
  return budget != null && requestedMaxTokens <= budget ? budget + ANSWER_HEADROOM_TOKENS : requestedMaxTokens;
}

/** A warning when a thinking budget forces `max_tokens` above the user's `maxOutputTokens`. */
function raisedMaxTokensWarnings(params: { settings: ProviderSettings; context: SettingsContext }): string[] {
  const { settings, context } = params;
  const { maxOutputTokens } = settings;
  const budget = thinkingBudget(settings);
  if (maxOutputTokens == null || budget == null) return [];
  const maxTokens = maxTokensFor({ settings, requestedMaxTokens: maxOutputTokens });
  if (maxTokens === maxOutputTokens) return [];
  return [`Provider '${PROVIDER_ID}' sends max_tokens ${maxTokens} instead of maxOutputTokens ${maxOutputTokens} for model '${context.model}': max_tokens must exceed the thinking budget of ${budget} tokens`];
}

/** How the adapter departs from the settings it keeps: a raised `max_tokens`, and reserved `providerOptions` keys it ignores. */
export function anthropicSettingsWarnings(settings: ProviderSettings, context: SettingsContext): string[] {
  const { providerOptions } = settings;
  return [
    ...raisedMaxTokensWarnings({ settings, context }),
    ...reservedOptionWarnings({ providerId: PROVIDER_ID, providerOptions, reserved: ANTHROPIC_RESERVED_BODY_FIELDS }),
  ];
}

/**
 * Maps settings to body fields. Combinations the API rejects are left out here too (see `anthropicUnsupportedSettings`),
 * so a caller using the provider directly gets the same request as a run.
 */
export function toAnthropicSettingsFields(params: AnthropicSettingsParams): AnthropicSettingsFields {
  const { settings, defaultMaxTokens } = params;
  const { maxOutputTokens, temperature, topP, stop } = settings;
  const conflicts = anthropicUnsupportedSettings(settings);
  const budget = thinkingBudget(settings);
  return {
    max_tokens: maxTokensFor({ settings, requestedMaxTokens: maxOutputTokens ?? defaultMaxTokens }),
    ...(temperature == null || conflicts.includes('temperature') ? {} : { temperature }),
    ...(topP == null || conflicts.includes('topP') ? {} : { top_p: topP }),
    ...(stop == null ? {} : { stop_sequences: stop }),
    ...(budget == null ? {} : { thinking: { type: 'enabled', budget_tokens: budget } }),
  };
}
