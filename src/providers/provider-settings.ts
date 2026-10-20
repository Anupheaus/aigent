import type { ProviderSettings } from './provider-types.js';

/** Every setting a provider can be sent, in the order warnings about them are reported. */
export const PROVIDER_SETTING_KEYS: readonly (keyof ProviderSettings)[] = [
  'maxOutputTokens', 'temperature', 'topP', 'thinking', 'effort', 'promptCaching', 'stop', 'seed', 'providerOptions',
];
