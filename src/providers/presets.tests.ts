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

describe('ollama preset', () => {
  it('needs no api key and sends no authorization header', async () => {
    const { fetch, requests } = finishedFetch();
    await drain(ollama({ fetch }));
    expect(new Headers(requests[0]?.init.headers).has('authorization')).toBe(false);
  });
});
