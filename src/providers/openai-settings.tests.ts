import { describe, expect, it } from 'vitest';
import { byteChunks, createFakeBody, createFakeFetch } from './fake-fetch.test-support.js';
import { openAiCompatible } from './openai-compatible.js';
import { finishChunk, sseBody } from './openai-fixtures.test-support.js';
import type { ProviderRequest, ProviderSettings } from './provider-types.js';

const BASE_URL = 'https://llm.test/v1';
const REQUEST: ProviderRequest = { model: 'test-model', messages: [{ role: 'user', text: 'hi' }], tools: [] };

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

  it('shallow-merges providerOptions into the body last, so they can override mapped fields', async () => {
    const body = await bodyFor({ temperature: 0.3, providerOptions: { temperature: 0.9, logprobs: true, response_format: { type: 'text' } } });
    expect(body).toMatchObject({ temperature: 0.9, logprobs: true, response_format: { type: 'text' }, model: 'test-model', stream: true });
  });

  it('reports effort as unusable when thinking is off, and nothing otherwise', () => {
    const { provider } = createProvider();
    expect(provider.unsupportedSettings?.({ effort: 'high', thinking: 'off' })).toEqual(['effort']);
    expect(provider.unsupportedSettings?.({ effort: 'high' })).toEqual([]);
    expect(provider.unsupportedSettings?.({ thinking: 'off' })).toEqual([]);
  });
});
