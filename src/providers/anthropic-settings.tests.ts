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
    const body = await bodyFor({ temperature: 0.4, topP: 0.8, maxOutputTokens: 300, stop: ['END', 'STOP'] });
    expect(body).toMatchObject({ temperature: 0.4, top_p: 0.8, max_tokens: 300, stop_sequences: ['END', 'STOP'] });
    expect(body).not.toHaveProperty('thinking');
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
  });

  describe('effort', () => {
    it.each([['low', 2048], ['medium', 8000], ['high', 16_000], ['max', 32_000]] as const)('maps effort %s to a %i-token thinking budget', async (effort, budget) => {
      const body = await bodyFor({ effort, maxOutputTokens: 64_000 });
      expect(body).toMatchObject({ thinking: { type: 'enabled', budget_tokens: budget }, max_tokens: 64_000 });
    });

    it('raises max_tokens to budget + 1024 when it would not exceed the budget', async () => {
      expect((await bodyFor({ effort: 'high', maxOutputTokens: 4000 })).max_tokens).toBe(16_000 + 1024);
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

  it('shallow-merges providerOptions into the body last', async () => {
    const body = await bodyFor({ temperature: 0.1, providerOptions: { temperature: 0.7, metadata: { user_id: 'u1' } } });
    expect(body).toMatchObject({ temperature: 0.7, metadata: { user_id: 'u1' }, model: 'claude-test', stream: true });
  });

  it('reports temperature with thinking, and effort with explicit thinking, as unusable', () => {
    const { provider } = createProvider();
    expect(provider.unsupportedSettings?.({ thinking: 'on', temperature: 0.2 })).toEqual(['temperature']);
    expect(provider.unsupportedSettings?.({ effort: 'low', temperature: 0.2 })).toEqual(['temperature']);
    expect(provider.unsupportedSettings?.({ thinking: 'off', effort: 'low', temperature: 0.2 })).toEqual(['effort']);
    expect(provider.unsupportedSettings?.({ thinking: { budgetTokens: 2000 }, effort: 'low' })).toEqual(['effort']);
    expect(provider.unsupportedSettings?.({ temperature: 0.2, effort: undefined })).toEqual([]);
  });
});
