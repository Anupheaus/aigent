import { describe, expect, it } from 'vitest';
import { isAigentError } from '../core/aigent-error.js';
import type { AigentError } from '../core/aigent-error.js';
import { byteChunks, createFakeBody, createFakeFetch, encodeText } from './fake-fetch.test-support.js';
import type { FakeBody, FakeResponseSpec, RecordedRequest } from './fake-fetch.test-support.js';
import { openAiCompatible } from './openai-compatible.js';
import type { OpenAiCompatibleOptions } from './openai-compatible.js';
import {
  finishChunk, interleavedToolCallChunks, reasoningChunk, sseBody, sseBodyWithoutDone, textChunk, toolCallChunk, usageChunk,
} from './openai-fixtures.test-support.js';
import type { ProviderEvent, ProviderRequest } from './provider-types.js';

const API_KEY = 'sk-secret-test-key-123';
const BASE_URL = 'https://llm.test/v1';
const REQUEST: ProviderRequest = { model: 'test-model', messages: [{ role: 'user', text: 'hi' }], tools: [] };
const MAX_ERROR_BODY_CHARS = 2000;

interface Harness {
  requests: RecordedRequest[];
  events(request?: ProviderRequest): Promise<ProviderEvent[]>;
  error(request?: ProviderRequest): Promise<AigentError>;
}

function chunked(text: string, size = 5): FakeResponseSpec {
  return { body: createFakeBody({ chunks: byteChunks({ text, size }) }) };
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function captureError(promise: Promise<unknown>): Promise<AigentError> {
  try {
    await promise;
  } catch (error) {
    if (isAigentError(error)) return error;
    throw error;
  }
  throw new Error('expected the stream to reject with an AigentError');
}

function harness(params: { respond: () => FakeResponseSpec; options?: Partial<OpenAiCompatibleOptions> }): Harness {
  const { respond, options } = params;
  const { fetch, requests } = createFakeFetch(respond);
  const provider = openAiCompatible({ id: 'test-llm', baseUrl: BASE_URL, apiKey: API_KEY, fetch, ...options });
  const events = (request = REQUEST): Promise<ProviderEvent[]> => collect(provider.stream(request, new AbortController().signal));
  return { requests, events, error: request => captureError(events(request)) };
}

function streaming(text: string): Harness {
  return harness({ respond: () => chunked(text) });
}

function sentBody(request: RecordedRequest | undefined): Record<string, unknown> {
  return JSON.parse(String(request?.init.body)) as Record<string, unknown>;
}

function sentHeaders(request: RecordedRequest | undefined): Headers {
  return new Headers(request?.init.headers);
}

const DONE_STOP: ProviderEvent = { type: 'done', finishReason: 'stop' };

describe('openAiCompatible request', () => {
  it('posts to {baseUrl}/chat/completions, tolerating a trailing slash', async () => {
    const { requests, events } = harness({ respond: () => chunked(sseBody([finishChunk('stop')])), options: { baseUrl: `${BASE_URL}/` } });
    await events();
    expect(requests[0]?.url).toBe(`${BASE_URL}/chat/completions`);
    expect(requests[0]?.init.method).toBe('POST');
  });

  it('sends content-type, bearer auth and custom headers', async () => {
    const { requests, events } = harness({ respond: () => chunked(sseBody([finishChunk('stop')])), options: { headers: { 'x-org': 'acme' } } });
    await events();
    const headers = sentHeaders(requests[0]);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(headers.get('x-org')).toBe('acme');
  });

  it('omits the authorization header when no api key is set', async () => {
    const { requests, events } = harness({ respond: () => chunked(sseBody([finishChunk('stop')])), options: { apiKey: undefined } });
    await events();
    expect(sentHeaders(requests[0]).has('authorization')).toBe(false);
  });

  it('passes the abort signal to fetch', async () => {
    const { requests, events } = streaming(sseBody([finishChunk('stop')]));
    await events();
    expect(requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('streams with usage, omits empty tools and max_tokens when unset', async () => {
    const { requests, events } = streaming(sseBody([finishChunk('stop')]));
    await events();
    expect(sentBody(requests[0])).toEqual({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('ignores cache breakpoints (OpenAI-compatible caching is automatic)', async () => {
    const { requests, events } = streaming(sseBody([finishChunk('stop')]));
    await events({ model: 'test-model', messages: [{ role: 'system', text: 's' }, { role: 'user', text: 'hi' }], tools: [], cacheBreakpoints: [0, 1] });
    expect(sentBody(requests[0])).toEqual({
      model: 'test-model',
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('maps tools with their strict flag and the maxOutputTokens setting to max_tokens', async () => {
    const { requests, events } = streaming(sseBody([finishChunk('stop')]));
    const parameters = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false };
    await events({
      ...REQUEST,
      settings: { maxOutputTokens: 256 },
      tools: [
        { name: 'search', description: 'Search things', parameters, strict: true },
        { name: 'aigent_multi', description: 'Batch', parameters: { type: 'object' }, strict: false },
      ],
    });
    const body = sentBody(requests[0]);
    expect(body.max_tokens).toBe(256);
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'search', description: 'Search things', parameters, strict: true } },
      { type: 'function', function: { name: 'aigent_multi', description: 'Batch', parameters: { type: 'object' }, strict: false } },
    ]);
  });

  it('maps every message role, assistant tool calls and tool results', async () => {
    const { requests, events } = streaming(sseBody([finishChunk('stop')]));
    await events({
      ...REQUEST,
      messages: [
        { role: 'system', text: 'be brief' },
        { role: 'user', text: 'find cats' },
        { role: 'assistant', text: 'Searching.', toolCalls: [{ id: 'c1', name: 'search', args: { q: 'cats' } }] },
        { role: 'tool', toolCallId: 'c1', text: '{"ok":true}' },
        { role: 'assistant', toolCalls: [{ id: 'c2', name: 'search', args: '{"q":"do' }] },
        { role: 'tool', toolCallId: 'c2', text: 'bad args' },
        { role: 'assistant', text: 'Done.' },
      ],
    });
    expect(sentBody(requests[0]).messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'find cats' },
      { role: 'assistant', content: 'Searching.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"cats"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'search', arguments: '{"q":"do' } }] },
      { role: 'tool', tool_call_id: 'c2', content: 'bad args' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });

  // `{ role: 'assistant', content: null }` without tool_calls is rejected by OpenAI, so a turn that said nothing is
  // dropped; the user messages around it merge, since some servers (e.g. deepseek-reasoner) reject consecutive user turns.
  it('drops an assistant message with no tool calls and only whitespace text, merging the user messages around it', async () => {
    const { requests, events } = streaming(sseBody([finishChunk('stop')]));
    await events({
      ...REQUEST,
      messages: [
        { role: 'system', text: 'be brief' },
        { role: 'user', text: 'first' },
        { role: 'assistant', text: '' },
        { role: 'user', text: 'second' },
        { role: 'assistant', text: ' \n' },
        { role: 'assistant' },
        { role: 'user', text: 'third' },
        { role: 'assistant', text: 'Fine.' },
      ],
    });
    expect(sentBody(requests[0]).messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'first\n\nsecond\n\nthird' },
      { role: 'assistant', content: 'Fine.' },
    ]);
  });
});

describe('openAiCompatible streaming', () => {
  it('turns content and reasoning deltas into text and thinking events', async () => {
    const events = await streaming(sseBody([
      reasoningChunk({ field: 'reasoning_content', text: 'hmm ' }),
      reasoningChunk({ field: 'reasoning', text: 'ok' }),
      textChunk('Hel'),
      textChunk('lo'),
      finishChunk('stop'),
    ])).events();
    expect(events).toEqual([
      { type: 'thinking-delta', text: 'hmm ' },
      { type: 'thinking-delta', text: 'ok' },
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      DONE_STOP,
    ]);
  });

  it('parses identically when the body arrives one byte at a time', async () => {
    const text = sseBody([textChunk('日本 😀 é'), ...interleavedToolCallChunks([{ id: 'c1', name: 'x', args: { a: 'é' } }]), finishChunk('tool_calls')]);
    const whole = await harness({ respond: () => ({ body: createFakeBody({ chunks: [encodeText(text)] }) }) }).events();
    const byteByByte = await harness({ respond: () => chunked(text, 1) }).events();
    expect(byteByByte).toEqual(whole);
    expect(whole).toContainEqual({ type: 'text-delta', text: '日本 😀 é' });
    expect(whole).toContainEqual({ type: 'tool-call', call: { id: 'c1', name: 'x', args: { a: 'é' } } });
  });

  it('keeps interleaved parallel tool calls distinct and emits them after the stream, in index order', async () => {
    const calls = [
      { id: 'call_b', name: 'lookup', args: { id: 'x-1', tags: ['a', 'b'] } },
      { id: 'call_a', name: 'search', args: { q: 'long query text', limit: 3 } },
    ];
    const events = await streaming(sseBody([...interleavedToolCallChunks(calls), finishChunk('tool_calls')])).events();
    expect(events).toEqual([
      { type: 'tool-call', call: calls[0] },
      { type: 'tool-call', call: calls[1] },
      { type: 'done', finishReason: 'tool_calls' },
    ]);
  });

  it('orders tool calls by index even when a higher index opens first', async () => {
    const events = await streaming(sseBody([
      toolCallChunk([{ index: 1, id: 'second', name: 'b', arguments: '{}' }]),
      toolCallChunk([{ index: 0, id: 'first', name: 'a', arguments: '{}' }]),
      finishChunk('tool_calls'),
    ])).events();
    expect(events.filter(event => event.type === 'tool-call').map(event => event.call.id)).toEqual(['first', 'second']);
  });

  // Some servers (older Ollama, llama.cpp, Gemini-compat) send each whole call in its own chunk, all at index 0.
  it('keeps calls distinct when every call reuses index 0 with a new id', async () => {
    const events = await streaming(sseBody([
      toolCallChunk([{ index: 0, id: 'call_a', name: 'add', arguments: '{"a":1}' }]),
      toolCallChunk([{ index: 0, id: 'call_b', name: 'mul', arguments: '{"b":2}' }]),
      finishChunk('tool_calls'),
    ])).events();
    expect(events.filter(event => event.type === 'tool-call')).toEqual([
      { type: 'tool-call', call: { id: 'call_a', name: 'add', args: { a: 1 } } },
      { type: 'tool-call', call: { id: 'call_b', name: 'mul', args: { b: 2 } } },
    ]);
  });

  it('keeps calls distinct when the server omits index, while still joining fragments that carry no id', async () => {
    const noIndex = (delta: Record<string, unknown>): string => JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [delta] }, finish_reason: null }] });
    const events = await streaming(sseBody([
      noIndex({ id: 'call_a', type: 'function', function: { name: 'add', arguments: '{"a"' } }),
      noIndex({ function: { arguments: ':1}' } }),
      noIndex({ id: 'call_b', type: 'function', function: { name: 'mul', arguments: '{"b":2}' } }),
      finishChunk('tool_calls'),
    ])).events();
    expect(events.filter(event => event.type === 'tool-call')).toEqual([
      { type: 'tool-call', call: { id: 'call_a', name: 'add', args: { a: 1 } } },
      { type: 'tool-call', call: { id: 'call_b', name: 'mul', args: { b: 2 } } },
    ]);
  });

  it('starts a new call when a new name arrives at the same index without an id after arguments were sent', async () => {
    const events = await streaming(sseBody([
      toolCallChunk([{ index: 0, name: 'add', arguments: '{"a":1}' }]),
      toolCallChunk([{ index: 0, name: 'mul', arguments: '{"b":2}' }]),
      finishChunk('tool_calls'),
    ])).events();
    const calls = events.flatMap(event => (event.type === 'tool-call' ? [event.call] : []));
    expect(calls.map(({ name, args }) => ({ name, args }))).toEqual([{ name: 'add', args: { a: 1 } }, { name: 'mul', args: { b: 2 } }]);
    expect(new Set(calls.map(({ id }) => id)).size).toBe(2);
  });

  it('starts a new call when the same name arrives without an id with a fresh object after complete arguments', async () => {
    const events = await streaming(sseBody([
      toolCallChunk([{ index: 0, name: 'add', arguments: '{"a":1}' }]),
      toolCallChunk([{ index: 0, name: 'add', arguments: '{"a":2}' }]),
      finishChunk('tool_calls'),
    ])).events();
    const calls = events.flatMap(event => (event.type === 'tool-call' ? [event.call] : []));
    expect(calls.map(({ args }) => args)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(new Set(calls.map(({ id }) => id)).size).toBe(2);
  });

  it('keeps one call when a server repeats the id and name on every fragment', async () => {
    const events = await streaming(sseBody([
      toolCallChunk([{ index: 0, id: 'call_a', name: 'add', arguments: '{"a"' }]),
      toolCallChunk([{ index: 0, id: 'call_a', name: 'add', arguments: ':1}' }]),
      toolCallChunk([{ index: 0, name: 'add', arguments: '' }]),
      finishChunk('tool_calls'),
    ])).events();
    expect(events.filter(event => event.type === 'tool-call')).toEqual([{ type: 'tool-call', call: { id: 'call_a', name: 'add', args: { a: 1 } } }]);
  });

  it('passes malformed arguments through as the raw string and empty arguments as {}', async () => {
    const events = await streaming(sseBody([
      toolCallChunk([{ index: 0, id: 'c1', name: 'a', arguments: '{"q": "unterminated' }]),
      toolCallChunk([{ index: 1, id: 'c2', name: 'b', arguments: '' }]),
      finishChunk('tool_calls'),
    ])).events();
    expect(events.filter(event => event.type === 'tool-call')).toEqual([
      { type: 'tool-call', call: { id: 'c1', name: 'a', args: '{"q": "unterminated' } },
      { type: 'tool-call', call: { id: 'c2', name: 'b', args: {} } },
    ]);
  });

  it('maps usage including OpenAI cached tokens', async () => {
    const events = await streaming(sseBody([
      textChunk('x'), finishChunk('stop'),
      usageChunk({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 } }),
    ])).events();
    expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 64 } }]);
  });

  it('maps DeepSeek prompt_cache_hit_tokens to cached tokens', async () => {
    const events = await streaming(sseBody([finishChunk('stop'), usageChunk({ prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 32 })])).events();
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 50, outputTokens: 5, cachedTokens: 32 } });
  });

  // Zeros would silently under-report accounting (e.g. a stream that ends after finish_reason but before the usage chunk).
  it('omits the usage event, rather than reporting zeros, when the server sends no usage', async () => {
    const events = await streaming(sseBodyWithoutDone([textChunk('x'), finishChunk('stop')])).events();
    expect(events).toEqual([{ type: 'text-delta', text: 'x' }, DONE_STOP]);
  });

  it('reports zero cached tokens when the server gives none', async () => {
    const events = await streaming(sseBody([finishChunk('stop'), usageChunk({ prompt_tokens: 9, completion_tokens: 1 })])).events();
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 9, outputTokens: 1, cachedTokens: 0 } });
  });

  it.each([
    ['stop', 'stop'],
    ['tool_calls', 'tool_calls'],
    ['function_call', 'tool_calls'],
    ['length', 'length'],
    ['content_filter', 'stop'],
  ])('maps finish_reason %s to %s', async (wireReason, finishReason) => {
    const events = await streaming(sseBody([textChunk('x'), finishChunk(wireReason)])).events();
    expect(events.at(-1)).toEqual({ type: 'done', finishReason });
  });

  // Older Ollama and Gemini-compat servers send `stop` even when the turn called tools.
  it.each([
    ['stop', 'tool_calls'],
    ['content_filter', 'tool_calls'],
    ['length', 'length'],
  ])('maps finish_reason %s with tool calls present to %s', async (wireReason, finishReason) => {
    const events = await streaming(sseBody([toolCallChunk([{ index: 0, id: 'c1', name: 'a', arguments: '{}' }]), finishChunk(wireReason)])).events();
    expect(events.at(-1)).toEqual({ type: 'done', finishReason });
  });

  it('finishes with tool_calls when [DONE] arrives without a finish_reason but tool calls exist', async () => {
    const events = await streaming(sseBody([toolCallChunk([{ index: 0, id: 'c1', name: 'a', arguments: '{}' }])])).events();
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('finishes with stop when [DONE] arrives without a finish_reason', async () => {
    const events = await streaming(sseBody([textChunk('x')])).events();
    expect(events.at(-1)).toEqual(DONE_STOP);
  });

  it('accepts a finish_reason without [DONE]', async () => {
    const events = await streaming(sseBodyWithoutDone([textChunk('x'), finishChunk('stop')])).events();
    expect(events.at(-1)).toEqual(DONE_STOP);
  });

  it('skips payloads that are not JSON', async () => {
    const events = await streaming(`data: keep-alive\n\n${sseBody([textChunk('x'), finishChunk('stop')])}`).events();
    expect(events).toEqual([{ type: 'text-delta', text: 'x' }, DONE_STOP]);
  });

  it('fails when a payload is JSON but not an object', async () => {
    const error = await streaming(sseBody(['42'])).error();
    expect(error.code).toBe('provider_failed');
    expect(error.message).toContain('test-llm');
  });

  it('fails when the server streams an error object', async () => {
    const error = await streaming(sseBody([JSON.stringify({ error: { message: 'model overloaded' } })])).error();
    expect(error.code).toBe('provider_failed');
    expect(error.message).toContain('model overloaded');
  });

  it('fails when the stream ends without finish_reason or [DONE]', async () => {
    const error = await streaming(sseBodyWithoutDone([textChunk('x')])).error();
    expect(error.code).toBe('provider_failed');
    expect(error.message).toContain('stream ended before completion');
    // A cut-off stream is a dropped connection, so it is worth retrying.
    expect(error.details).toMatchObject({ retryable: true });
  });
});

describe('openAiCompatible errors', () => {
  it.each([
    [400, false], [401, false], [404, false], [408, true], [409, true], [429, true], [500, true], [503, true],
  ])('HTTP %i fails with retryable %s and redacts the key from the stored body', async (status, retryable) => {
    const error = await harness({ respond: () => ({ status, body: `{"error":"nope","key":"${API_KEY}"}` }) }).error();
    expect(error.code).toBe('provider_failed');
    expect(error.details).toMatchObject({ status, retryable, body: '{"error":"nope","key":"[REDACTED]"}' });
    expect(JSON.stringify(error.details)).not.toContain(API_KEY);
    expect(error.message).toContain('test-llm');
    expect(error.message).toContain(String(status));
    expect(error.message).not.toContain(API_KEY);
  });

  it('names the server reason from a JSON error body in the message, redacted', async () => {
    const body = JSON.stringify({ error: { message: `The model 'gpt-x' does not exist for key ${API_KEY}`, type: 'invalid_request_error' } });
    const error = await harness({ respond: () => ({ status: 404, body }) }).error();
    expect(error.message).toContain("The model 'gpt-x' does not exist for key [REDACTED]");
    expect(error.message).not.toContain(API_KEY);
  });

  it('accepts a plain string error field as the server reason and ignores non-JSON bodies', async () => {
    const plain = await harness({ respond: () => ({ status: 400, body: '{"error":"bad model name"}' }) }).error();
    expect(plain.message).toContain('bad model name');
    const html = await harness({ respond: () => ({ status: 502, body: '<html>Bad Gateway</html>' }) }).error();
    expect(html.message).not.toContain('<html>');
  });

  it('fails clearly, keeping the body, when a 2xx response is not an event stream', async () => {
    const body = '{"error":{"message":"streaming disabled by proxy"}}';
    const error = await harness({ respond: () => ({ status: 200, body, headers: { 'content-type': 'application/json' } }) }).error();
    expect(error.code).toBe('provider_failed');
    expect(error.message).toContain('application/json');
    expect(error.message).toContain('text/event-stream');
    expect(error.message).toContain('streaming disabled by proxy');
    expect(error.details).toMatchObject({ status: 200, retryable: false, body });
  });

  it('still reads the stream when a 2xx response has no content-type', async () => {
    const events = await harness({ respond: () => ({ ...chunked(sseBody([textChunk('x'), finishChunk('stop')])), headers: {} }) }).events();
    expect(events).toEqual([{ type: 'text-delta', text: 'x' }, DONE_STOP]);
  });

  it('redacts secret custom header values from error bodies', async () => {
    const azureKey = 'azure-secret-value-456';
    const error = await harness({
      respond: () => ({ status: 401, body: `bad api-key ${azureKey}` }),
      options: { headers: { 'api-key': azureKey } },
    }).error();
    expect(error.details?.body).toBe('bad api-key [REDACTED]');
  });

  it('redacts the key from a streamed error message and from quoted stream payloads', async () => {
    const streamed = await streaming(sseBody([JSON.stringify({ error: { message: `Incorrect API key provided: ${API_KEY}` } })])).error();
    expect(streamed.message).toContain('Incorrect API key provided: [REDACTED]');
    const quoted = await streaming(sseBody([JSON.stringify(API_KEY)])).error();
    expect(quoted.code).toBe('provider_failed');
    expect(quoted.message).not.toContain(API_KEY);
  });

  it('keeps at most 2000 characters of an error body', async () => {
    const error = await harness({ respond: () => ({ status: 500, body: 'x'.repeat(MAX_ERROR_BODY_CHARS * 3) }) }).error();
    expect(error.details?.body).toBe('x'.repeat(MAX_ERROR_BODY_CHARS));
  });

  it('maps a fetch rejection to provider_failed with the cause', async () => {
    const provider = openAiCompatible({
      id: 'test-llm', baseUrl: BASE_URL, apiKey: API_KEY, fetch: () => Promise.reject(new TypeError('getaddrinfo ENOTFOUND llm.test')),
    });
    const error = await captureError(collect(provider.stream(REQUEST, new AbortController().signal)));
    expect(error.code).toBe('provider_failed');
    expect(error.message).toContain('ENOTFOUND');
    expect(error.message).not.toContain(API_KEY);
  });

  it('maps a fetch rejection caused by abort to aborted', async () => {
    const controller = new AbortController();
    const provider = openAiCompatible({
      id: 'test-llm', baseUrl: BASE_URL, fetch: () => { controller.abort(); return Promise.reject(new DOMException('aborted', 'AbortError')); },
    });
    const error = await captureError(collect(provider.stream(REQUEST, controller.signal)));
    expect(error.code).toBe('aborted');
  });

  it('maps a mid-stream network error to provider_failed and never hangs', async () => {
    const body = createFakeBody({ chunks: [encodeText(sseBodyWithoutDone([textChunk('partial')]))], ending: 'error' });
    const error = await harness({ respond: () => ({ body }) }).error();
    expect(error.code).toBe('provider_failed');
    expect(error.message).toContain('socket hang up');
  });
});

describe('openAiCompatible abort and cancellation', () => {
  function hangingBody(): FakeBody {
    return createFakeBody({ chunks: [encodeText(sseBodyWithoutDone([textChunk('a'), textChunk('b')]))], ending: 'hang' });
  }

  it('throws aborted at once when the signal is already aborted, without calling fetch', async () => {
    const { fetch, requests } = createFakeFetch(() => ({ body: hangingBody() }));
    const provider = openAiCompatible({ id: 'test-llm', baseUrl: BASE_URL, fetch });
    const controller = new AbortController();
    controller.abort();
    const error = await captureError(collect(provider.stream(REQUEST, controller.signal)));
    expect(error.code).toBe('aborted');
    expect(requests).toHaveLength(0);
  });

  it('stops reading a body that never ends, cancels it and throws aborted', async () => {
    const body = hangingBody();
    const { fetch } = createFakeFetch(() => ({ body }));
    const provider = openAiCompatible({ id: 'test-llm', baseUrl: BASE_URL, fetch });
    const controller = new AbortController();
    const seen: ProviderEvent[] = [];
    let seenAtAbort = -1;
    const run = (async (): Promise<void> => {
      for await (const event of provider.stream(REQUEST, controller.signal)) {
        seen.push(event);
        if (seenAtAbort === -1) {
          seenAtAbort = seen.length;
          // Abort while the adapter is waiting on a read that would otherwise never complete.
          setTimeout(() => controller.abort(), 10);
        }
      }
    })();
    const error = await captureError(run);
    expect(error.code).toBe('aborted');
    expect(seen).toHaveLength(seenAtAbort + 1);
    expect(body.isCancelled()).toBe(true);
  });

  it('throws aborted and cancels the body when aborted while reading a stalled error body', async () => {
    const body = createFakeBody({ chunks: [encodeText('{"error":')], ending: 'hang' });
    // This fetch ignores the signal, like a custom one might; only cancelling the body can end the read.
    const { fetch } = createFakeFetch(() => ({ status: 500, body }));
    const provider = openAiCompatible({ id: 'test-llm', baseUrl: BASE_URL, fetch });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const error = await captureError(collect(provider.stream(REQUEST, controller.signal)));
    expect(error.code).toBe('aborted');
    expect(body.isCancelled()).toBe(true);
  });

  it('throws aborted when the error body read fails because of the abort', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        // Like undici: aborting the request errors the body.
        controller.abort();
        streamController.error(new DOMException('aborted', 'AbortError'));
      },
    });
    const provider = openAiCompatible({ id: 'test-llm', baseUrl: BASE_URL, fetch: async () => new Response(stream, { status: 503 }) });
    const error = await captureError(collect(provider.stream(REQUEST, controller.signal)));
    expect(error.code).toBe('aborted');
  });

  it('cancels the body when the consumer stops early', async () => {
    const body = hangingBody();
    const { fetch } = createFakeFetch(() => ({ body }));
    const provider = openAiCompatible({ id: 'test-llm', baseUrl: BASE_URL, fetch });
    for await (const event of provider.stream(REQUEST, new AbortController().signal)) {
      if (event.type === 'text-delta') break;
    }
    expect(body.isCancelled()).toBe(true);
  });
});

describe('openAiCompatible capabilities', () => {
  it('defaults to streaming tool calling with a 128k context', () => {
    const provider = openAiCompatible({ id: 'x', baseUrl: BASE_URL });
    expect(provider.id).toBe('x');
    expect(provider.capabilities).toEqual({
      streaming: true, toolCalling: true, parallelToolCalls: true, promptCaching: false, vision: false, maxContextTokens: 128_000,
      supportedSettings: ['maxOutputTokens', 'temperature', 'topP', 'stop', 'seed', 'effort', 'providerOptions'],
    });
  });

  it('honours maxContextTokens and supportsParallelToolCalls', () => {
    const { capabilities } = openAiCompatible({ id: 'x', baseUrl: BASE_URL, maxContextTokens: 32_000, supportsParallelToolCalls: false });
    expect(capabilities).toMatchObject({ parallelToolCalls: false, maxContextTokens: 32_000 });
  });
});
