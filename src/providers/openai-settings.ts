import type { ProviderSettings } from './provider-types.js';

/** `reasoning_effort` values; OpenAI has no level above `high`. */
export type OpenAiReasoningEffort = 'low' | 'medium' | 'high';

/** Chat Completions body fields that settings map to. */
export interface OpenAiSettingsFields {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  seed?: number;
  reasoning_effort?: OpenAiReasoningEffort;
}

/** Settings this adapter maps; `thinking` and `promptCaching` have no Chat Completions equivalent. */
export const OPENAI_SUPPORTED_SETTINGS: (keyof ProviderSettings)[] = ['maxOutputTokens', 'temperature', 'topP', 'stop', 'seed', 'effort', 'providerOptions'];

const REASONING_EFFORT: Record<NonNullable<ProviderSettings['effort']>, OpenAiReasoningEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high',
};

/** `effort` cannot be honoured when thinking was explicitly turned off: sending it would turn reasoning back on. */
export function openAiUnsupportedSettings(settings: ProviderSettings): (keyof ProviderSettings)[] {
  const { thinking, effort } = settings;
  return thinking === 'off' && effort != null ? ['effort'] : [];
}

/** Maps settings to body fields; `providerOptions` is merged separately, last. */
export function toOpenAiSettingsFields(settings: ProviderSettings): OpenAiSettingsFields {
  const { maxOutputTokens, temperature, topP, stop, seed, effort, thinking } = settings;
  return {
    ...(maxOutputTokens == null ? {} : { max_tokens: maxOutputTokens }),
    ...(temperature == null ? {} : { temperature }),
    ...(topP == null ? {} : { top_p: topP }),
    ...(stop == null ? {} : { stop }),
    ...(seed == null ? {} : { seed }),
    ...(effort == null || thinking === 'off' ? {} : { reasoning_effort: REASONING_EFFORT[effort] }),
  };
}
