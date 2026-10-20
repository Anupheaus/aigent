import { describe, expect, it } from 'vitest';
import { byteChunks, createFakeBody, createFakeFetch } from './fake-fetch.test-support.js';
import { openAiCompatible } from './openai-compatible.js';
import { finishChunk, sseBody } from './openai-fixtures.test-support.js';
import type { ProviderRequest, ProviderSettings } from './provider-types.js';

const BASE_URL = 'https://llm.test/v1';
const REQUEST: ProviderRequest = { model: 'test-model', messages: [{ role: 'user', text: 'hi' }], tools: [] };
const CONTEXT = { model: 'test-model' };

function createProvider() {
  const { fetch, requests } = createFakeFetch(() => ({ body: createFakeBody({ chunks: byteChunks({ text: sseBody([finishChunk('stop')]), size: 16 }) }) }));
  return { provider: openAiCompatible({ id: 'test-llm', baseUrl: BASE_URL, fetch }), requests };
}

async function bodyFor(settings: ProviderSettings): Promise<Record<string, unknown>> {
  const { provider, requests } = createProvider();
  for await (const _event of provider.stream({ ...REQUEST, settings }, new AbortController().signal)) { /* drain */ }
  return JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
}

describe('openAiCompatible settings', () => {
  it('declares the settings it can map', () => {
    expect(createProvider().provider.capabilities.supportedSettings).toEqual(['maxOutputTokens', 'temperature', 'topP', 'stop', 'seed', 'effort', 'providerOptions']);
  });

  it('maps temperature, topP, maxOutputTokens, stop and seed', async () => {
    const body = await bodyFor({ temperature: 0.3, topP: 0.9, maxOutputTokens: 256, stop: ['END'], seed: 42 });
    expect(body).toMatchObject({ temperature: 0.3, top_p: 0.9, max_tokens: 256, stop: ['END'], seed: 42 });
  });

  it('sends none of the setting fields when no settings are given', async () => {
    const body = await bodyFor({});
    for (const field of ['temperature', 'top_p', 'max_tokens', 'stop', 'seed', 'reasoning_effort']) expect(body).not.toHaveProperty(field);
  });

  it.each([['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['max', 'high']] as const)('maps effort %s to reasoning_effort %s', async (effort, expected) => {
    expect((await bodyFor({ effort })).reasoning_effort).toBe(expected);
    expect((await bodyFor({ effort, thinking: 'on' })).reasoning_effort).toBe(expected);
  });

  it('does not send reasoning_effort when thinking is off', async () => {
    expect(await bodyFor({ effort: 'high', thinking: 'off' })).not.toHaveProperty('reasoning_effort');
  });

  it('never sends thinking or promptCaching', async () => {
    const body = await bodyFor({ thinking: { budgetTokens: 2048 }, promptCaching: true });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('prompt_caching');
    expect(body).not.toHaveProperty('promptCaching');
  });

  it('merges providerOptions into the body without letting them replace a field the adapter sets', async () => {
    const body = await bodyFor({
      temperature: 0.3,
      providerOptions: { temperature: 0.9, stream: false, stream_options: {}, model: 'other', messages: [], tools: [], max_tokens: 1, max_completion_tokens: 1, top_p: 0.1, stop: ['Z'], seed: 4, reasoning_effort: 'high', logprobs: true, response_format: { type: 'text' } },
    });
    expect(body).toMatchObject({ temperature: 0.3, model: 'test-model', stream: true, stream_options: { include_usage: true }, logprobs: true, response_format: { type: 'text' } });
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    for (const field of ['tools', 'max_tokens', 'max_completion_tokens', 'top_p', 'stop', 'seed', 'reasoning_effort']) expect(body).not.toHaveProperty(field);
  });

  it('warns about each providerOptions key it ignores because the adapter sets that field', () => {
    const { provider } = createProvider();
    expect(provider.settingsWarnings?.({ providerOptions: { stream: false, logprobs: true } }, CONTEXT)).toEqual([
      "Provider 'test-llm' ignores providerOptions key 'stream': the adapter sets that field (use the matching model setting instead)",
    ]);
  });

  it('reports effort as unusable when thinking is off, and nothing otherwise', () => {
    const { provider } = createProvider();
    expect(provider.unsupportedSettings?.({ effort: 'high', thinking: 'off' }, CONTEXT)).toEqual(['effort']);
    expect(provider.unsupportedSettings?.({ effort: 'high' }, CONTEXT)).toEqual([]);
    expect(provider.unsupportedSettings?.({ thinking: 'off' }, CONTEXT)).toEqual([]);
  });

  // Reasoning models reject non-default sampling settings and stop sequences.
  it('treats temperature, topP and stop as unusable when reasoning_effort is sent and no model matcher is given', () => {
    const { provider } = createProvider();
    expect(provider.unsupportedSettings?.({ effort: 'high', temperature: 0.2, topP: 0.9, stop: ['x'] }, CONTEXT)).toEqual(['temperature', 'topP', 'stop']);
    expect(provider.unsupportedSettings?.({ temperature: 0.2, topP: 0.9, stop: ['x'] }, CONTEXT)).toEqual([]);
    expect(provider.unsupportedSettings?.({ effort: 'high', thinking: 'off', temperature: 0.2 }, CONTEXT)).toEqual(['effort']);
  });

  describe('with isReasoningModel', () => {
    const provider = openAiCompatible({ id: 'test-llm', baseUrl: BASE_URL, isReasoningModel: model => model.startsWith('o') });

    it('drops sampling settings and stop for reasoning models, even without effort', () => {
      expect(provider.unsupportedSettings?.({ effort: 'low', temperature: 0.2, topP: 0.9, stop: ['x'], seed: 1 }, { model: 'o3' })).toEqual(['temperature', 'topP', 'stop']);
      expect(provider.unsupportedSettings?.({ temperature: 0.2 }, { model: 'o3' })).toEqual(['temperature']);
    });

    it('drops effort for other models, keeping their sampling settings', () => {
      expect(provider.unsupportedSettings?.({ effort: 'low', temperature: 0.2, topP: 0.9, stop: ['x'] }, { model: 'gpt-4o' })).toEqual(['effort']);
    });
  });

  it('sends maxOutputTokens as max_completion_tokens when tokenLimitField says so', async () => {
    const { fetch, requests } = createFakeFetch(() => ({ body: createFakeBody({ chunks: byteChunks({ text: sseBody([finishChunk('stop')]), size: 16 }) }) }));
    const provider = openAiCompatible({ id: 'test-llm', baseUrl: BASE_URL, fetch, tokenLimitField: 'max_completion_tokens' });
    for await (const _event of provider.stream({ ...REQUEST, settings: { maxOutputTokens: 500 } }, new AbortController().signal)) { /* drain */ }
    const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(500);
    expect(body).not.toHaveProperty('max_tokens');
  });
});
