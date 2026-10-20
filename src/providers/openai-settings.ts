import type { ProviderSettings, SettingsContext } from './provider-types.js';

/** `reasoning_effort` values; OpenAI has no level above `high`. */
export type OpenAiReasoningEffort = 'low' | 'medium' | 'high';

/**
 * The body field `maxOutputTokens` maps to. OpenAI's current models (reasoning ones require it) take
 * `max_completion_tokens`; DeepSeek, Ollama and most other compatible servers take `max_tokens`.
 */
export type OpenAiTokenLimitField = 'max_tokens' | 'max_completion_tokens';

/** Chat Completions body fields that settings map to. */
export interface OpenAiSettingsFields {
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  seed?: number;
  reasoning_effort?: OpenAiReasoningEffort;
}

export interface OpenAiSettingsParams {
  settings: ProviderSettings;
  tokenLimitField: OpenAiTokenLimitField;
}

/** Tells reasoning models (which take `reasoning_effort` and reject sampling settings) from the rest, by model id. */
export type ReasoningModelMatcher = (model: string) => boolean;

/** Settings this adapter maps; `thinking` and `promptCaching` have no Chat Completions equivalent. */
export const OPENAI_SUPPORTED_SETTINGS: (keyof ProviderSettings)[] = ['maxOutputTokens', 'temperature', 'topP', 'stop', 'seed', 'effort', 'providerOptions'];

/** Settings reasoning models reject (anything but the default temperature/top_p, and stop sequences). */
const REASONING_REJECTED_SETTINGS: readonly (keyof ProviderSettings)[] = ['temperature', 'topP', 'stop'];

const REASONING_EFFORT: Record<NonNullable<ProviderSettings['effort']>, OpenAiReasoningEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high',
};

/** `reasoning_effort` is sent unless thinking was explicitly turned off: sending it would turn reasoning back on. */
function sendsReasoningEffort(settings: ProviderSettings): boolean {
  const { effort, thinking } = settings;
  return effort != null && thinking !== 'off';
}

/**
 * The combination rules: `effort` is dropped when thinking is off. With a `isReasoningModel` matcher, reasoning models
 * also drop `temperature`, `topP` and `stop`, and other models drop `effort`. Without one, a request that sends
 * `reasoning_effort` is assumed to target a reasoning model.
 */
export function createOpenAiUnsupportedSettings(isReasoningModel?: ReasoningModelMatcher): (settings: ProviderSettings, context: SettingsContext) => (keyof ProviderSettings)[] {
  return (settings, { model }) => {
    const { effort } = settings;
    const isReasoning = isReasoningModel?.(model) ?? sendsReasoningEffort(settings);
    const conflicts: (keyof ProviderSettings)[] = [];
    if (effort != null && (!sendsReasoningEffort(settings) || !isReasoning)) conflicts.push('effort');
    if (isReasoning) conflicts.push(...REASONING_REJECTED_SETTINGS.filter(key => settings[key] != null));
    return conflicts;
  };
}

/** Maps settings to body fields; `providerOptions` is merged separately. */
export function toOpenAiSettingsFields(params: OpenAiSettingsParams): OpenAiSettingsFields {
  const { settings, tokenLimitField } = params;
  const { maxOutputTokens, temperature, topP, stop, seed, effort } = settings;
  return {
    ...(maxOutputTokens == null ? {} : { [tokenLimitField]: maxOutputTokens }),
    ...(temperature == null ? {} : { temperature }),
    ...(topP == null ? {} : { top_p: topP }),
    ...(stop == null ? {} : { stop }),
    ...(seed == null ? {} : { seed }),
    ...(effort == null || !sendsReasoningEffort(settings) ? {} : { reasoning_effort: REASONING_EFFORT[effort] }),
  };
}
