import type { Provider } from '../providers/provider-types.js';
import { createAigentError } from './aigent-error.js';
import { parseModelReference } from './model-reference.js';
import { parseModelSettings } from './model-settings.js';
import type { ModelSettings } from './model-settings.js';
import type { ModelTarget } from './start-task-run.js';

export interface CreateTargetResolverParams {
  providers: Provider[];
  /** `createAigent({ providerModelSettings })`, keyed by provider id. */
  providerModelSettings?: Record<string, ModelSettings>;
}

/** Turns `provider:model` references into targets (provider resolved, its settings layer attached). */
export type TargetResolver = (reference: string) => ModelTarget;

function indexProviders(providers: Provider[]): Map<string, Provider> {
  const byId = new Map<string, Provider>();
  for (const provider of providers) {
    if (byId.has(provider.id)) {
      throw createAigentError({ code: 'invalid_definition', message: `Duplicate provider id '${provider.id}'; each provider must have a unique id`, details: { providerId: provider.id } });
    }
    byId.set(provider.id, provider);
  }
  return byId;
}

function unknownProviderError(params: { providerId: string; providersById: Map<string, Provider> }): Error {
  const { providerId, providersById } = params;
  const knownIds = [...providersById.keys()].join(', ') || '(none)';
  return createAigentError({ code: 'unknown_provider', message: `Unknown provider '${providerId}'; known providers: ${knownIds}`, details: { providerId } });
}

/** Validates every per-provider settings layer up front, so a typo fails at `createAigent`, not on a later task. */
function parseProviderModelSettings(params: { settings: Record<string, ModelSettings> | undefined; providersById: Map<string, Provider> }): Map<string, ModelSettings> {
  const { settings = {}, providersById } = params;
  return new Map(Object.entries(settings).map(([providerId, providerSettings]) => {
    if (!providersById.has(providerId)) throw unknownProviderError({ providerId, providersById });
    return [providerId, parseModelSettings({ owner: `Provider '${providerId}'`, settings: providerSettings }) ?? {}];
  }));
}

/** Validates the providers and their settings layers once; the resolver throws `unknown_provider` for other ids. */
export function createTargetResolver(params: CreateTargetResolverParams): TargetResolver {
  const providersById = indexProviders(params.providers);
  const providerSettingsById = parseProviderModelSettings({ settings: params.providerModelSettings, providersById });
  return reference => {
    const { providerId, model } = parseModelReference(reference);
    const provider = providersById.get(providerId);
    if (provider == null) throw unknownProviderError({ providerId, providersById });
    const providerSettings = providerSettingsById.get(providerId);
    return { reference, provider, model, ...(providerSettings == null ? {} : { providerSettings }) };
  };
}
