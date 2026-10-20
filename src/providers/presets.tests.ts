import { describe, expect, it } from 'vitest';
import { createFakeBody, createFakeFetch, encodeText } from './fake-fetch.test-support.js';
import type { FakeFetch } from './fake-fetch.test-support.js';
import { finishChunk, sseBody } from './openai-fixtures.test-support.js';
import { deepseek, ollama, openai } from './presets.js';
import type { Provider, ProviderRequest } from './provider-types.js';

const REQUEST: ProviderRequest = { model: 'm', messages: [{ role: 'user', text: 'hi' }], tools: [] };

function finishedFetch(): FakeFetch {
  return createFakeFetch(() => ({ body: createFakeBody({ chunks: [encodeText(sseBody([finishChunk('stop')]))] }) }));
}

async function drain(provider: Provider): Promise<void> {
  for await (const event of provider.stream(REQUEST, new AbortController().signal)) void event;
}

const DEFAULT_CAPABILITIES = {
  streaming: true, toolCalling: true, parallelToolCalls: true, promptCaching: false, vision: false, maxContextTokens: 128_000,
  supportedSettings: ['maxOutputTokens', 'temperature', 'topP', 'stop', 'seed', 'effort', 'providerOptions'],
};

describe.each([
  { preset: deepseek, id: 'deepseek', url: 'https://api.deepseek.com/chat/completions' },
  { preset: openai, id: 'openai', url: 'https://api.openai.com/v1/chat/completions' },
  { preset: ollama, id: 'ollama', url: 'http://localhost:11434/v1/chat/completions' },
])('$id preset', ({ preset, id, url }) => {
  it('has its id and default capabilities', () => {
    const provider = preset({});
    expect(provider.id).toBe(id);
    expect(provider.capabilities).toEqual(DEFAULT_CAPABILITIES);
  });

  it('posts to its default base URL with the given key', async () => {
    const { fetch, requests } = finishedFetch();
    await drain(preset({ apiKey: 'k-1', fetch }));
    expect(requests[0]?.url).toBe(url);
    expect(new Headers(requests[0]?.init.headers).get('authorization')).toBe('Bearer k-1');
  });

  it('accepts a base URL override', async () => {
    const { fetch, requests } = finishedFetch();
    await drain(preset({ baseUrl: 'http://proxy.test/api', fetch }));
    expect(requests[0]?.url).toBe('http://proxy.test/api/chat/completions');
  });
});

describe('token limit field', () => {
  it.each([
    { preset: openai, field: 'max_completion_tokens', other: 'max_tokens' },
    { preset: deepseek, field: 'max_tokens', other: 'max_completion_tokens' },
    { preset: ollama, field: 'max_tokens', other: 'max_completion_tokens' },
  ])('sends maxOutputTokens as $field', async ({ preset, field, other }) => {
    const { fetch, requests } = finishedFetch();
    for await (const event of preset({ fetch }).stream({ ...REQUEST, settings: { maxOutputTokens: 300 } }, new AbortController().signal)) void event;
    const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
    expect(body[field]).toBe(300);
    expect(body).not.toHaveProperty(other);
  });
});

describe('openai preset reasoning models', () => {
  const provider = openai({});

  it.each(['o1', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini'])('treats %s as a reasoning model: no temperature, topP or stop', model => {
    expect(provider.unsupportedSettings?.({ effort: 'high', temperature: 0.2, topP: 0.5, stop: ['x'] }, { model })).toEqual(['temperature', 'topP', 'stop']);
  });

  it.each(['gpt-4o', 'gpt-4.1-mini'])('treats %s as a sampling model: no effort', model => {
    expect(provider.unsupportedSettings?.({ effort: 'high', temperature: 0.2 }, { model })).toEqual(['effort']);
  });

  it('accepts its own isReasoningModel', () => {
    const custom = openai({ isReasoningModel: model => model === 'my-reasoner' });
    expect(custom.unsupportedSettings?.({ temperature: 0.2 }, { model: 'my-reasoner' })).toEqual(['temperature']);
    expect(custom.unsupportedSettings?.({ effort: 'low' }, { model: 'gpt-5' })).toEqual(['effort']);
  });
});

describe('ollama preset', () => {
  it('needs no api key and sends no authorization header', async () => {
    const { fetch, requests } = finishedFetch();
    await drain(ollama({ fetch }));
    expect(new Headers(requests[0]?.init.headers).has('authorization')).toBe(false);
  });
});
