import { describe, expect, it } from 'vitest';
import { resolveModelSettings } from './resolve-model-settings.js';

describe('resolveModelSettings', () => {
  it('returns no settings when no layer has any', () => {
    expect(resolveModelSettings({})).toEqual({});
    expect(resolveModelSettings({ task: {}, agent: {}, runtime: {}, provider: {} })).toEqual({});
  });

  it('takes each field from the highest layer that sets it: task > agent > runtime > provider', () => {
    const resolved = resolveModelSettings({
      task: { temperature: 0.1 },
      agent: { temperature: 0.2, topP: 0.5 },
      runtime: { temperature: 0.3, topP: 0.6, maxOutputTokens: 100 },
      provider: { temperature: 0.4, topP: 0.7, maxOutputTokens: 200, seed: 7 },
    });
    expect(resolved).toEqual({ temperature: 0.1, topP: 0.5, maxOutputTokens: 100, seed: 7 });
  });

  it('lets an undefined field fall through to the next layer', () => {
    const resolved = resolveModelSettings({ task: { temperature: undefined }, agent: { temperature: 0.7 } });
    expect(resolved).toEqual({ temperature: 0.7 });
    expect(Object.keys(resolved)).toEqual(['temperature']);
  });

  it('replaces whole values such as stop lists and thinking objects rather than merging them', () => {
    const resolved = resolveModelSettings({ task: { stop: ['x'], thinking: 'off' }, agent: { stop: ['a', 'b'], thinking: { budgetTokens: 2048 } } });
    expect(resolved).toEqual({ stop: ['x'], thinking: 'off' });
  });

  it('shallow-merges providerOptions with higher layers winning per key', () => {
    const resolved = resolveModelSettings({
      task: { providerOptions: { a: 'task' } },
      agent: { providerOptions: { a: 'agent', b: 'agent' } },
      runtime: { providerOptions: { c: { deep: 'runtime' } } },
      provider: { providerOptions: { b: 'provider', c: { other: 'provider' }, d: 'provider' } },
    });
    expect(resolved).toEqual({ providerOptions: { a: 'task', b: 'agent', c: { deep: 'runtime' }, d: 'provider' } });
  });

  it('does not mutate its layers', () => {
    const agent = { providerOptions: { a: 1 } };
    resolveModelSettings({ task: { providerOptions: { b: 2 } }, agent });
    expect(agent).toEqual({ providerOptions: { a: 1 } });
  });
});
