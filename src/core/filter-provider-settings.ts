import { PROVIDER_SETTING_KEYS } from '../providers/provider-settings.js';
import type { Provider, ProviderSettings, SettingsContext } from '../providers/provider-types.js';
import type { ModelSettings } from './model-settings.js';

export interface FilterProviderSettingsParams {
  provider: Provider;
  /** Model id without the provider prefix; some rules depend on it. */
  model: string;
  /** Fully resolved settings, runtime-only fields included. */
  settings: ModelSettings;
}

export interface FilteredProviderSettings {
  /** What may be sent; absent when nothing is left. */
  settings?: ProviderSettings;
  /** One message per setting left out. */
  warnings: string[];
}

type SettingsRecord = Record<string, unknown>;

/**
 * The provider-facing settings that are actually set, in `PROVIDER_SETTING_KEYS` order, with `providerOptions` narrowed
 * to this provider's entry (left out when it has none, or an empty one).
 */
function providerFacing(params: { settings: ModelSettings; providerId: string }): ProviderSettings {
  const { settings: { providerOptions, ...rest }, providerId } = params;
  const ownOptions = providerOptions?.[providerId];
  const record: SettingsRecord = { ...rest, ...(ownOptions == null || Object.keys(ownOptions).length === 0 ? {} : { providerOptions: ownOptions }) };
  return Object.fromEntries(PROVIDER_SETTING_KEYS.filter(key => record[key] !== undefined).map(key => [key, record[key]])) as ProviderSettings;
}

/**
 * Splits resolved settings into what `provider` can honour and a warning for each setting it cannot: first those
 * outside `capabilities.supportedSettings`, then those its `unsupportedSettings` check rejects in this combination.
 * The check sees the full settings, since a dropped field (e.g. `thinking: 'off'`) can decide another's fate. Last
 * come the provider's own `settingsWarnings` about what it keeps.
 */
export function filterProviderSettings(params: FilterProviderSettingsParams): FilteredProviderSettings {
  const { provider: { id, capabilities: { supportedSettings }, unsupportedSettings, settingsWarnings }, model, settings } = params;
  const context: SettingsContext = { model };
  const facing = providerFacing({ settings, providerId: id });
  const present = Object.keys(facing) as (keyof ProviderSettings)[];
  const unsupported = new Set(present.filter(key => !supportedSettings.includes(key)));
  const conflicting = new Set((unsupportedSettings?.(facing, context) ?? []).filter(key => present.includes(key) && !unsupported.has(key)));
  const dropWarnings = present.flatMap(key => {
    if (unsupported.has(key)) return [`Provider '${id}' does not support setting '${key}'; ignored`];
    if (conflicting.has(key)) return [`Provider '${id}' cannot honour setting '${key}' together with the other settings of this request; ignored`];
    return [];
  });
  const kept = Object.fromEntries(Object.entries(facing).filter(([key]) => !unsupported.has(key as keyof ProviderSettings) && !conflicting.has(key as keyof ProviderSettings)));
  if (Object.keys(kept).length === 0) return { warnings: dropWarnings };
  const keptSettings = kept as ProviderSettings;
  return { settings: keptSettings, warnings: [...dropWarnings, ...(settingsWarnings?.(keptSettings, context) ?? [])] };
}
