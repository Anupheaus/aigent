import { describe, expect, it } from 'vitest';
import { anthropic } from './anthropic.js';
import type { AnthropicOptions } from './anthropic.js';
import { anthropicSse, messageDelta, messageStart, messageStop } from './anthropic-fixtures.test-support.js';
import { byteChunks, createFakeBody, createFakeFetch } from './fake-fetch.test-support.js';
import type { ProviderRequest, ProviderSettings } from './provider-types.js';

const REQUEST: ProviderRequest = { model: 'claude-test', messages: [{ role: 'system', text: 'Be brief' }, { role: 'user', text: 'hi' }], tools: [] };
const EMPTY_TURN = anthropicSse([messageStart(), messageDelta({ stopReason: 'end_turn', outputTokens: 0 }), messageStop()]);

function createProvider(options: Partial<AnthropicOptions> = {}) {
  const { fetch, requests } = createFakeFetch(() => ({ body: createFakeBody({ chunks: byteChunks({ text: EMPTY_TURN, size: 16 }) }) }));
  return { provider: anthropic({ apiKey: 'sk-ant-test-key-123456', baseUrl: 'https://anthropic.test', fetch, ...options }), requests };
}

async function bodyFor(settings: ProviderSettings, options: Partial<AnthropicOptions> = {}): Promise<Record<string, unknown>> {
  const { provider, requests } = createProvider(options);
  for await (const _event of provider.stream({ ...REQUEST, settings }, new AbortController().signal)) { /* drain */ }
  return JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
}

describe('anthropic settings', () => {
  it('declares the settings it can map (seed is not one)', () => {
    expect(createProvider().provider.capabilities.supportedSettings).toEqual(['maxOutputTokens', 'temperature', 'topP', 'thinking', 'effort', 'promptCaching', 'stop', 'providerOptions']);
  });

  it('maps temperature, topP, maxOutputTokens and stop', async () => {
    const body = await bodyFor({ temperature: 0.4, maxOutputTokens: 300, stop: ['END', 'STOP'] });
    expect(body).toMatchObject({ temperature: 0.4, max_tokens: 300, stop_sequences: ['END', 'STOP'] });
    expect(body).not.toHaveProperty('thinking');
    expect(await bodyFor({ topP: 0.8 })).toMatchObject({ top_p: 0.8 });
  });

  // Current models reject temperature and top_p together.
  it('sends temperature without top_p when both are set', async () => {
    const body = await bodyFor({ temperature: 0.4, topP: 0.8 });
    expect(body.temperature).toBe(0.4);
    expect(body).not.toHaveProperty('top_p');
  });

  it('never sends seed', async () => {
    expect(await bodyFor({ seed: 3 })).not.toHaveProperty('seed');
  });

  describe('thinking', () => {
    it("maps 'on' to an 8000-token budget when maxOutputTokens is unknown, raising max_tokens above it", async () => {
      const body = await bodyFor({ thinking: 'on' });
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
      expect(body.max_tokens).toBe(8000 + 1024);
    });

    it("maps 'on' to min(maxOutputTokens - 1, 8000)", async () => {
      expect(await bodyFor({ thinking: 'on', maxOutputTokens: 5000 })).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 4999 }, max_tokens: 5000 });
      expect(await bodyFor({ thinking: 'on', maxOutputTokens: 20_000 })).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 8000 }, max_tokens: 20_000 });
    });

    it("keeps an 'on' budget at the API minimum of 1024 when maxOutputTokens is smaller, raising max_tokens", async () => {
      expect(await bodyFor({ thinking: 'on', maxOutputTokens: 500 })).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 1024 }, max_tokens: 2048 });
    });

    it('maps an explicit budget as given', async () => {
      expect(await bodyFor({ thinking: { budgetTokens: 3000 }, maxOutputTokens: 10_000 })).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 3000 }, max_tokens: 10_000 });
    });

    it("omits thinking when 'off', even with an effort", async () => {
      const body = await bodyFor({ thinking: 'off', effort: 'high', temperature: 0.5 });
      expect(body).not.toHaveProperty('thinking');
      expect(body.temperature).toBe(0.5);
    });

    it('drops temperature when thinking is enabled, since the API requires the default', async () => {
      expect(await bodyFor({ thinking: 'on', temperature: 0.2 })).not.toHaveProperty('temperature');
      expect(await bodyFor({ effort: 'low', temperature: 0.2 })).not.toHaveProperty('temperature');
    });

    // With thinking on the API accepts top_p only in [0.95, 1].
    it('drops a topP below 0.95 while thinking, and keeps one of 0.95 or more', async () => {
      expect(await bodyFor({ thinking: 'on', topP: 0.5 })).not.toHaveProperty('top_p');
      expect(await bodyFor({ thinking: 'on', topP: 0.95 })).toMatchObject({ top_p: 0.95 });
      expect(await bodyFor({ thinking: 'on', temperature: 0.3, topP: 0.97 })).toMatchObject({ top_p: 0.97 });
    });
  });

  describe('effort', () => {
    it.each([['low', 2048], ['medium', 8000], ['high', 16_000], ['max', 32_000]] as const)('maps effort %s to a %i-token thinking budget', async (effort, budget) => {
      const body = await bodyFor({ effort, maxOutputTokens: 64_000 });
      expect(body).toMatchObject({ thinking: { type: 'enabled', budget_tokens: budget }, max_tokens: 64_000 });
    });

    it('clamps the effort budget below maxOutputTokens, so the user cap holds', async () => {
      expect(await bodyFor({ effort: 'high', maxOutputTokens: 4000 })).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 3999 }, max_tokens: 4000 });
      expect(await bodyFor({ effort: 'max', maxOutputTokens: 20_000 })).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 19_999 }, max_tokens: 20_000 });
    });

    it('keeps the effort budget at the API minimum of 1024, raising max_tokens only when maxOutputTokens is that small', async () => {
      expect(await bodyFor({ effort: 'max', maxOutputTokens: 1000 })).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 1024 }, max_tokens: 2048 });
    });

    it('raises defaultMaxTokens (not a user cap) to budget + 1024 when it would not exceed the budget', async () => {
      expect((await bodyFor({ effort: 'high' }, { defaultMaxTokens: 16_000 })).max_tokens).toBe(16_000 + 1024);
    });

    it('is ignored when thinking is set explicitly', async () => {
      expect((await bodyFor({ effort: 'max', thinking: { budgetTokens: 2000 }, maxOutputTokens: 9000 })).thinking).toEqual({ type: 'enabled', budget_tokens: 2000 });
    });
  });

  it('lets promptCaching override the adapter option', async () => {
    expect((await bodyFor({ promptCaching: false })).system).toBe('Be brief');
    expect((await bodyFor({ promptCaching: true }, { promptCaching: false })).system).toEqual([{ type: 'text', text: 'Be brief', cache_control: { type: 'ephemeral' } }]);
  });

  it('merges providerOptions into the body without letting them replace a field the adapter sets', async () => {
    const body = await bodyFor({
      temperature: 0.1,
      providerOptions: { temperature: 0.7, stream: false, model: 'other', max_tokens: 10, top_p: 0.1, thinking: { type: 'enabled', budget_tokens: 2000 }, messages: [], system: 'x', tools: [], stop_sequences: ['Z'], metadata: { user_id: 'u1' }, top_k: 5 },
    });
    expect(body).toMatchObject({ temperature: 0.1, model: 'claude-test', stream: true, max_tokens: 4096, system: [{ type: 'text', text: 'Be brief', cache_control: { type: 'ephemeral' } }], metadata: { user_id: 'u1' }, top_k: 5 });
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    for (const field of ['top_p', 'thinking', 'tools', 'stop_sequences']) expect(body).not.toHaveProperty(field);
  });

  it('warns about each providerOptions key it ignores because the adapter sets that field', () => {
    const { provider } = createProvider();
    expect(provider.settingsWarnings?.({ providerOptions: { stream: false, metadata: {}, thinking: {} } }, { model: 'claude-test' })).toEqual([
      "Provider 'anthropic' ignores providerOptions key 'stream': the adapter sets that field (use the matching model setting instead)",
      "Provider 'anthropic' ignores providerOptions key 'thinking': the adapter sets that field (use the matching model setting instead)",
    ]);
  });

  it('reports temperature with thinking, and effort with explicit thinking, as unusable', () => {
    const { provider } = createProvider();
    const context = { model: 'claude-test' };
    expect(provider.unsupportedSettings?.({ thinking: 'on', temperature: 0.2 }, context)).toEqual(['temperature']);
    expect(provider.unsupportedSettings?.({ effort: 'low', temperature: 0.2 }, context)).toEqual(['temperature']);
    expect(provider.unsupportedSettings?.({ thinking: 'off', effort: 'low', temperature: 0.2 }, context)).toEqual(['effort']);
    expect(provider.unsupportedSettings?.({ thinking: { budgetTokens: 2000 }, effort: 'low' }, context)).toEqual(['effort']);
    expect(provider.unsupportedSettings?.({ temperature: 0.2, effort: undefined }, context)).toEqual([]);
  });

  it('reports topP below 0.95 with thinking, and topP alongside temperature, as unusable', () => {
    const { provider } = createProvider();
    const context = { model: 'claude-test' };
    expect(provider.unsupportedSettings?.({ thinking: 'on', topP: 0.5 }, context)).toEqual(['topP']);
    expect(provider.unsupportedSettings?.({ effort: 'low', topP: 0.94 }, context)).toEqual(['topP']);
    expect(provider.unsupportedSettings?.({ thinking: 'on', topP: 0.95 }, context)).toEqual([]);
    expect(provider.unsupportedSettings?.({ temperature: 0.2, topP: 0.8 }, context)).toEqual(['topP']);
    expect(provider.unsupportedSettings?.({ thinking: 'off', temperature: 0.2, topP: 0.8 }, context)).toEqual(['topP']);
  });

  it('warns when a thinking budget forces max_tokens above maxOutputTokens, and only then', () => {
    const { provider } = createProvider();
    const context = { model: 'claude-test' };
    expect(provider.settingsWarnings?.({ effort: 'max', maxOutputTokens: 1000 }, context)).toEqual([
      "Provider 'anthropic' sends max_tokens 2048 instead of maxOutputTokens 1000 for model 'claude-test': max_tokens must exceed the thinking budget of 1024 tokens",
    ]);
    expect(provider.settingsWarnings?.({ thinking: { budgetTokens: 3000 }, maxOutputTokens: 3000 }, context)).toEqual([
      "Provider 'anthropic' sends max_tokens 4024 instead of maxOutputTokens 3000 for model 'claude-test': max_tokens must exceed the thinking budget of 3000 tokens",
    ]);
    expect(provider.settingsWarnings?.({ thinking: 'on', maxOutputTokens: 5000 }, context)).toEqual([]);
    expect(provider.settingsWarnings?.({ effort: 'max' }, context)).toEqual([]);
  });
});
