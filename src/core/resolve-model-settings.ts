import type { ModelSettings } from './model-settings.js';

/** The places settings come from, highest precedence first. */
export interface ModelSettingsLayers {
  task?: ModelSettings;
  agent?: ModelSettings;
  /** `createAigent({ modelSettings })`. */
  runtime?: ModelSettings;
  /** `createAigent({ providerModelSettings })` for the agent's provider. */
  provider?: ModelSettings;
}

type SettingsRecord = Record<string, unknown>;
type ProviderOptionsByProvider = NonNullable<ModelSettings['providerOptions']>;

/** `higher` over `lower`, per provider id, each provider's entry shallow-merged with `higher` winning per key. */
function mergeProviderOptions(params: { lower?: ProviderOptionsByProvider; higher: ProviderOptionsByProvider }): ProviderOptionsByProvider {
  const { lower = {}, higher } = params;
  const merged: ProviderOptionsByProvider = { ...lower };
  for (const [providerId, options] of Object.entries(higher)) merged[providerId] = { ...lower[providerId], ...options };
  return merged;
}

/**
 * Resolves field by field, task > agent > runtime > provider: a layer's `undefined` falls through to the next.
 * `providerOptions` is the exception: each provider's entry is shallow-merged across layers, higher layers winning
 * per key.
 */
export function resolveModelSettings(layers: ModelSettingsLayers): ModelSettings {
  const { task, agent, runtime, provider } = layers;
  // Lowest precedence first, so each later layer overwrites the fields it defines.
  const ordered = [provider, runtime, agent, task].filter((layer): layer is ModelSettings => layer != null);
  const resolved: SettingsRecord = {};
  let providerOptions: ProviderOptionsByProvider | undefined;
  for (const layer of ordered) {
    for (const [field, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      if (field === 'providerOptions') providerOptions = mergeProviderOptions({ lower: providerOptions, higher: value as ProviderOptionsByProvider });
      else resolved[field] = value;
    }
  }
  if (providerOptions != null) resolved.providerOptions = providerOptions;
  return resolved as ModelSettings;
}
