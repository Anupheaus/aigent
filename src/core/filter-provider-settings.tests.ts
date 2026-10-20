import { describe, expect, it } from 'vitest';
import type { Provider, ProviderCapabilities, ProviderSettings } from '../providers/provider-types.js';
import { filterProviderSettings } from './filter-provider-settings.js';

const CAPABILITIES: ProviderCapabilities = {
  streaming: true, toolCalling: true, parallelToolCalls: true, promptCaching: false, vision: false, maxContextTokens: 1_000,
  supportedSettings: ['maxOutputTokens', 'temperature', 'effort', 'providerOptions'],
};

function providerWith(unsupportedSettings?: Provider['unsupportedSettings']): Provider {
  return { id: 'p', capabilities: CAPABILITIES, stream: async function* () { yield* []; }, ...(unsupportedSettings == null ? {} : { unsupportedSettings }) };
}

describe('filterProviderSettings', () => {
  it('passes supported settings through and leaves out the runtime-only ones', () => {
    const { settings, warnings } = filterProviderSettings({ provider: providerWith(), settings: { temperature: 0.5, maxOutputTokens: 10, contextSize: 50_000, showThinking: false } });
    expect(settings).toEqual({ temperature: 0.5, maxOutputTokens: 10 });
    expect(warnings).toEqual([]);
  });

  it('returns no settings when nothing is left to send', () => {
    expect(filterProviderSettings({ provider: providerWith(), settings: { contextSize: 1 } }).settings).toBeUndefined();
    expect(filterProviderSettings({ provider: providerWith(), settings: {} })).toEqual({ warnings: [] });
  });

  it('drops each setting the provider does not support, with one warning each', () => {
    const { settings, warnings } = filterProviderSettings({ provider: providerWith(), settings: { temperature: 1, seed: 3, stop: ['x'] } });
    expect(settings).toEqual({ temperature: 1 });
    expect(warnings).toEqual([
      "Provider 'p' does not support setting 'stop'; ignored",
      "Provider 'p' does not support setting 'seed'; ignored",
    ]);
  });

  it('drops settings the provider cannot honour in this combination, asking it with the full settings', () => {
    const seen: ProviderSettings[] = [];
    const provider = providerWith(settings => { seen.push(settings); return settings.thinking === 'off' ? ['effort'] : []; });
    const { settings, warnings } = filterProviderSettings({ provider, settings: { thinking: 'off', effort: 'high', temperature: 1 } });
    expect(seen).toEqual([{ thinking: 'off', effort: 'high', temperature: 1 }]);
    expect(settings).toEqual({ temperature: 1 });
    expect(warnings).toEqual([
      "Provider 'p' does not support setting 'thinking'; ignored",
      "Provider 'p' cannot honour setting 'effort' together with the other settings of this request; ignored",
    ]);
  });

  it('does not warn about undefined settings', () => {
    expect(filterProviderSettings({ provider: providerWith(), settings: { seed: undefined, temperature: 1 } })).toEqual({ settings: { temperature: 1 }, warnings: [] });
  });
});
