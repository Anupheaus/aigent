import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAigentError } from '../core/aigent-error.js';
import type { AigentError } from '../core/aigent-error.js';
import { anthropic } from './anthropic.js';
import { createFakeFetch } from './fake-fetch.test-support.js';
import { openAiCompatible } from './openai-compatible.js';
import type { Provider, ProviderRequest } from './provider-types.js';
import { parseRetryAfterMs } from './retry-after.js';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const REQUEST: ProviderRequest = { model: 'm', messages: [{ role: 'user', text: 'hi' }], tools: [] };
const RATE_LIMITED_BODY = '{"error":{"message":"slow down"}}';

describe('parseRetryAfterMs', () => {
  it.each([
    ['2', 2_000],
    ['0', 0],
    ['1.5', 1_500],
    [' 3 ', 3_000],
    ['Tue, 20 Oct 2026 12:00:05 GMT', 5_000],
    ['Tue, 20 Oct 2026 11:59:00 GMT', 0],
  ])('reads %j as %i ms', (value, expected) => {
    expect(parseRetryAfterMs({ value, now: NOW })).toBe(expected);
  });

  it.each([null, '', 'soon', '-1', 'Not a date at all'])('ignores %j', value => {
    expect(parseRetryAfterMs({ value, now: NOW })).toBeUndefined();
  });
});

async function failure(provider: Provider): Promise<AigentError> {
  try {
    for await (const _event of provider.stream(REQUEST, new AbortController().signal)) { /* drain */ }
  } catch (error) {
    if (isAigentError(error)) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe.each([
  { name: 'openAiCompatible', create: (fetch: typeof globalThis.fetch) => openAiCompatible({ id: 'llm', baseUrl: 'https://llm.test/v1', fetch }) },
  { name: 'anthropic', create: (fetch: typeof globalThis.fetch) => anthropic({ apiKey: 'sk-ant-test-key-123456', baseUrl: 'https://anthropic.test', fetch }) },
])('$name retry-after', ({ create }) => {
  afterEach(() => { vi.useRealTimers(); });

  function rateLimited(headers: Record<string, string>): Provider {
    return create(createFakeFetch(() => ({ status: 429, body: RATE_LIMITED_BODY, headers })).fetch);
  }

  it('surfaces a retry-after given in seconds as details.retryAfterMs', async () => {
    const error = await failure(rateLimited({ 'retry-after': '3' }));
    expect(error).toMatchObject({ code: 'provider_failed', details: { status: 429, retryable: true, retryAfterMs: 3_000 } });
  });

  it('surfaces a retry-after given as an HTTP date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const error = await failure(rateLimited({ 'retry-after': 'Tue, 20 Oct 2026 12:00:10 GMT' }));
    expect(error.details?.retryAfterMs).toBe(10_000);
  });

  it('leaves retryAfterMs out when there is no usable header', async () => {
    expect((await failure(rateLimited({}))).details).not.toHaveProperty('retryAfterMs');
    expect((await failure(rateLimited({ 'retry-after': 'later' }))).details).not.toHaveProperty('retryAfterMs');
  });
});
