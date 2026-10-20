import { describe, expect, it } from 'vitest';
import type { Provider, ProviderCapabilities } from '../providers/provider-types.js';
import { filterProviderSettings } from './filter-provider-settings.js';

const CAPABILITIES: ProviderCapabilities = {
  streaming: true, toolCalling: true, parallelToolCalls: true, promptCaching: false, vision: false, maxContextTokens: 1_000,
  supportedSettings: ['maxOutputTokens', 'temperature', 'effort', 'providerOptions'],
};
const MODEL = 'm1';

interface ProviderHooks {
  unsupportedSettings?: Provider['unsupportedSettings'];
  settingsWarnings?: Provider['settingsWarnings'];
}

function providerWith(hooks: ProviderHooks = {}): Provider {
  return { id: 'p', capabilities: CAPABILITIES, stream: async function* () { yield* []; }, ...hooks };
}

describe('filterProviderSettings', () => {
  it('passes supported settings through and leaves out the runtime-only ones', () => {
    const { settings, warnings } = filterProviderSettings({ provider: providerWith(), model: MODEL, settings: { temperature: 0.5, maxOutputTokens: 10, contextSize: 50_000, showThinking: false } });
    expect(settings).toEqual({ temperature: 0.5, maxOutputTokens: 10 });
    expect(warnings).toEqual([]);
  });

  it('returns no settings when nothing is left to send', () => {
    expect(filterProviderSettings({ provider: providerWith(), model: MODEL, settings: { contextSize: 1 } }).settings).toBeUndefined();
    expect(filterProviderSettings({ provider: providerWith(), model: MODEL, settings: {} })).toEqual({ warnings: [] });
  });

  it('drops each setting the provider does not support, with one warning each', () => {
    const { settings, warnings } = filterProviderSettings({ provider: providerWith(), model: MODEL, settings: { temperature: 1, seed: 3, stop: ['x'] } });
    expect(settings).toEqual({ temperature: 1 });
    expect(warnings).toEqual([
      "Provider 'p' does not support setting 'stop'; ignored",
      "Provider 'p' does not support setting 'seed'; ignored",
    ]);
  });

  it('drops settings the provider cannot honour in this combination, asking it with the full settings and the model', () => {
    const seen: unknown[] = [];
    const unsupportedSettings: Provider['unsupportedSettings'] = (settings, context) => {
      seen.push({ settings, context });
      return settings.thinking === 'off' ? ['effort'] : [];
    };
    const { settings, warnings } = filterProviderSettings({ provider: providerWith({ unsupportedSettings }), model: MODEL, settings: { thinking: 'off', effort: 'high', temperature: 1 } });
    expect(seen).toEqual([{ settings: { thinking: 'off', effort: 'high', temperature: 1 }, context: { model: MODEL } }]);
    expect(settings).toEqual({ temperature: 1 });
    expect(warnings).toEqual([
      "Provider 'p' does not support setting 'thinking'; ignored",
      "Provider 'p' cannot honour setting 'effort' together with the other settings of this request; ignored",
    ]);
  });

  it("sends only this provider's providerOptions, flattened, and none when it has no entry", () => {
    const providerOptions = { p: { metadata: { user_id: 'u' } }, other: { logprobs: true } };
    expect(filterProviderSettings({ provider: providerWith(), model: MODEL, settings: { providerOptions } }).settings).toEqual({ providerOptions: { metadata: { user_id: 'u' } } });
    expect(filterProviderSettings({ provider: providerWith(), model: MODEL, settings: { providerOptions: { other: { logprobs: true } } } })).toEqual({ warnings: [] });
    expect(filterProviderSettings({ provider: providerWith(), model: MODEL, settings: { providerOptions: { p: {} } } })).toEqual({ warnings: [] });
  });

  it('does not warn about undefined settings', () => {
    expect(filterProviderSettings({ provider: providerWith(), model: MODEL, settings: { seed: undefined, temperature: 1 } })).toEqual({ settings: { temperature: 1 }, warnings: [] });
  });

  it("adds the provider's own warnings about the settings it keeps, after the dropped ones", () => {
    const seen: unknown[] = [];
    const settingsWarnings: Provider['settingsWarnings'] = (settings, context) => { seen.push({ settings, context }); return ['raised max_tokens']; };
    const { settings, warnings } = filterProviderSettings({ provider: providerWith({ settingsWarnings }), model: MODEL, settings: { maxOutputTokens: 10, seed: 1 } });
    expect(settings).toEqual({ maxOutputTokens: 10 });
    expect(seen).toEqual([{ settings: { maxOutputTokens: 10 }, context: { model: MODEL } }]);
    expect(warnings).toEqual(["Provider 'p' does not support setting 'seed'; ignored", 'raised max_tokens']);
  });

  it('does not ask for warnings when no settings are kept', () => {
    let calls = 0;
    const settingsWarnings: Provider['settingsWarnings'] = () => { calls += 1; return ['never']; };
    expect(filterProviderSettings({ provider: providerWith({ settingsWarnings }), model: MODEL, settings: { seed: 1 } }).warnings).toEqual(["Provider 'p' does not support setting 'seed'; ignored"]);
    expect(calls).toBe(0);
  });
});
