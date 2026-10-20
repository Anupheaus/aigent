import type { ProviderSettings } from './provider-types.js';

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

/** Budget for `thinking: 'on'` when `maxOutputTokens` does not force a smaller one. */
const DEFAULT_THINKING_BUDGET = 8000;
/** The API's smallest accepted thinking budget. */
const MIN_THINKING_BUDGET = 1024;
/** Room left for the visible answer when `max_tokens` has to be raised above the thinking budget. */
const ANSWER_HEADROOM_TOKENS = 1024;

const EFFORT_THINKING_BUDGET: Record<NonNullable<ProviderSettings['effort']>, number> = {
  low: 2048,
  medium: 8000,
  high: 16_000,
  max: 32_000,
};

/**
 * The thinking budget the settings ask for, or undefined for no thinking. An explicit `thinking` wins; otherwise
 * `effort` picks a budget. Never below the API minimum.
 */
function thinkingBudget(settings: ProviderSettings): number | undefined {
  const { thinking, effort, maxOutputTokens } = settings;
  if (thinking === 'off') return undefined;
  if (thinking === 'on') return Math.max(MIN_THINKING_BUDGET, Math.min((maxOutputTokens ?? Infinity) - 1, DEFAULT_THINKING_BUDGET));
  if (thinking != null) return thinking.budgetTokens;
  return effort == null ? undefined : EFFORT_THINKING_BUDGET[effort];
}

/**
 * Supported settings the API cannot take together: `temperature` while thinking (the API requires the default), and
 * `effort` alongside an explicit `thinking`, which decides the budget instead.
 */
export function anthropicUnsupportedSettings(settings: ProviderSettings): (keyof ProviderSettings)[] {
  const { thinking, effort, temperature } = settings;
  const conflicts: (keyof ProviderSettings)[] = [];
  if (temperature != null && thinkingBudget(settings) != null) conflicts.push('temperature');
  if (effort != null && thinking != null) conflicts.push('effort');
  return conflicts;
}

/** Maps settings to body fields. With thinking on, `max_tokens` is raised when it would not exceed the budget, as the API requires. */
export function toAnthropicSettingsFields(params: AnthropicSettingsParams): AnthropicSettingsFields {
  const { settings, defaultMaxTokens } = params;
  const { maxOutputTokens, temperature, topP, stop } = settings;
  const budget = thinkingBudget(settings);
  const requestedMaxTokens = maxOutputTokens ?? defaultMaxTokens;
  const maxTokens = budget != null && requestedMaxTokens <= budget ? budget + ANSWER_HEADROOM_TOKENS : requestedMaxTokens;
  return {
    max_tokens: maxTokens,
    ...(temperature == null || budget != null ? {} : { temperature }),
    ...(topP == null ? {} : { top_p: topP }),
    ...(stop == null ? {} : { stop_sequences: stop }),
    ...(budget == null ? {} : { thinking: { type: 'enabled', budget_tokens: budget } }),
  };
}
