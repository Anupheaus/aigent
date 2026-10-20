import { describe, expect, it } from 'vitest';
import { modelSettingsSchema, parseModelSettings } from './model-settings.js';

const VALID: unknown[] = [
  {},
  { contextSize: 32_000, maxOutputTokens: 1, temperature: 0, topP: 1 },
  { temperature: 2, topP: 0 },
  { thinking: 'off' },
  { thinking: 'on', effort: 'max' },
  { thinking: { budgetTokens: 1024 } },
  { effort: 'low', showThinking: false, promptCaching: true },
  { stop: ['a', 'b', 'c', 'd'] },
  { seed: 0 },
  { providerOptions: { logprobs: true, nested: { x: 1 } } },
];

interface InvalidCase {
  settings: unknown;
  /** Text the error message must name (the failing field). */
  names: string;
}

const INVALID: InvalidCase[] = [
  { settings: { contextSize: 0 }, names: 'contextSize' },
  { settings: { maxOutputTokens: 1.5 }, names: 'maxOutputTokens' },
  { settings: { maxOutputTokens: -1 }, names: 'maxOutputTokens' },
  { settings: { temperature: 2.1 }, names: 'temperature' },
  { settings: { temperature: -0.1 }, names: 'temperature' },
  { settings: { topP: 1.01 }, names: 'topP' },
  { settings: { thinking: 'maybe' }, names: 'thinking' },
  { settings: { thinking: { budgetTokens: 1023 } }, names: 'thinking.budgetTokens' },
  { settings: { thinking: { budgetTokens: 2000, extra: 1 } }, names: 'thinking' },
  { settings: { effort: 'extreme' }, names: 'effort' },
  { settings: { stop: ['a', 'b', 'c', 'd', 'e'] }, names: 'stop' },
  { settings: { stop: [''] }, names: 'stop.0' },
  { settings: { seed: 1.5 }, names: 'seed' },
  { settings: { seed: -1 }, names: 'seed' },
  { settings: { showThinking: 'yes' }, names: 'showThinking' },
  { settings: { temprature: 1 }, names: 'temprature' },
];

describe('modelSettingsSchema', () => {
  it.each(VALID)('accepts %j', settings => {
    expect(modelSettingsSchema.safeParse(settings).success).toBe(true);
  });

  it.each(INVALID)('rejects $settings', ({ settings }) => {
    expect(modelSettingsSchema.safeParse(settings).success).toBe(false);
  });
});

describe('parseModelSettings', () => {
  it('returns undefined when no settings are given and the parsed settings otherwise', () => {
    expect(parseModelSettings({ owner: "Agent 'a'", settings: undefined })).toBeUndefined();
    expect(parseModelSettings({ owner: "Agent 'a'", settings: { temperature: 0.5 } })).toEqual({ temperature: 0.5 });
  });

  it.each(INVALID)('throws invalid_definition naming the owner and $names', ({ settings, names }) => {
    expect(() => parseModelSettings({ owner: "Agent 'writer'", settings })).toThrow(expect.objectContaining({
      code: 'invalid_definition',
      message: expect.stringMatching(new RegExp(`^Agent 'writer' has invalid modelSettings: .*${names.replace('.', '\\.')}`)),
    }));
  });
});
