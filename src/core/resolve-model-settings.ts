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

/**
 * Resolves field by field, task > agent > runtime > provider: a layer's `undefined` falls through to the next.
 * `providerOptions` is the exception: it is shallow-merged across layers, higher layers winning per key.
 */
export function resolveModelSettings(layers: ModelSettingsLayers): ModelSettings {
  const { task, agent, runtime, provider } = layers;
  // Lowest precedence first, so each later layer overwrites the fields it defines.
  const ordered = [provider, runtime, agent, task].filter((layer): layer is ModelSettings => layer != null);
  const resolved: SettingsRecord = {};
  let providerOptions: SettingsRecord | undefined;
  for (const layer of ordered) {
    for (const [field, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      if (field === 'providerOptions') providerOptions = { ...providerOptions, ...(value as SettingsRecord) };
      else resolved[field] = value;
    }
  }
  if (providerOptions != null) resolved.providerOptions = providerOptions;
  return resolved as ModelSettings;
}
