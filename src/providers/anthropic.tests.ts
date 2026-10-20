import { describe, expect, it } from 'vitest';
import { isAigentError } from '../core/aigent-error.js';
import type { AigentError } from '../core/aigent-error.js';
import { anthropic } from './anthropic.js';
import type { AnthropicOptions } from './anthropic.js';
import {
  anthropicSse, blockStop, errorEvent, inputJsonDelta, interleavedToolUseBlocks, messageDelta, messageStart, messageStop, ping, textBlock,
  textBlockStart, textDelta, thinkingBlockStart, thinkingDelta, toolUseBlockStart,
} from './anthropic-fixtures.test-support.js';
import type { AnthropicEventFixture } from './anthropic-fixtures.test-support.js';
import { byteChunks, createFakeBody, createFakeFetch, encodeText } from './fake-fetch.test-support.js';
import type { FakeBody, FakeResponseSpec, RecordedRequest } from './fake-fetch.test-support.js';
import type { ProviderEvent, ProviderRequest } from './provider-types.js';

const API_KEY = 'sk-ant-secret-test-key-123';
const BASE_URL = 'https://anthropic.test';
const REQUEST: ProviderRequest = { model: 'claude-test', messages: [{ role: 'user', text: 'hi' }], tools: [] };
const DEFAULT_MAX_TOKENS = 4096;

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

function harness(params: { respond: () => FakeResponseSpec; options?: Partial<AnthropicOptions> }): Harness {
  const { respond, options } = params;
  const { fetch, requests } = createFakeFetch(respond);
  const provider = anthropic({ apiKey: API_KEY, baseUrl: BASE_URL, fetch, ...options });
  const events = (request = REQUEST): Promise<ProviderEvent[]> => collect(provider.stream(request, new AbortController().signal));
  return { requests, events, error: request => captureError(events(request)) };
}

function streaming(events: AnthropicEventFixture[]): Harness {
  return harness({ respond: () => chunked(anthropicSse(events)) });
}

/** The smallest complete stream: no content, `end_turn`. */
const EMPTY_TURN = [messageStart(), messageDelta({ stopReason: 'end_turn', outputTokens: 0 }), messageStop()];

function sentBody(request: RecordedRequest | undefined): Record<string, unknown> {
  return JSON.parse(String(request?.init.body)) as Record<string, unknown>;
}

async function bodyFor(params: { request: ProviderRequest; options?: Partial<AnthropicOptions> }): Promise<Record<string, unknown>> {
  const { request, options } = params;
  const { requests, events } = harness({ respond: () => chunked(anthropicSse(EMPTY_TURN)), options });
  await events(request);
  return sentBody(requests[0]);
}

const DONE_STOP: ProviderEvent = { type: 'done', finishReason: 'stop' };
const ZERO_USAGE: ProviderEvent = { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } };

describe('anthropic request', () => {
  it('posts to {baseUrl}/v1/messages with the key and version headers', async () => {
    const { requests, events } = harness({ respond: () => chunked(anthropicSse(EMPTY_TURN)), options: { baseUrl: `${BASE_URL}/` } });
    await events();
    const [request] = requests;
    expect(request?.url).toBe(`${BASE_URL}/v1/messages`);
    expect(request?.init.method).toBe('POST');
    expect(request?.init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(request?.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-api-key')).toBe(API_KEY);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.has('authorization')).toBe(false);
  });

  it('defaults to api.anthropic.com and honours a custom version', async () => {
    const { fetch, requests } = createFakeFetch(() => chunked(anthropicSse(EMPTY_TURN)));
    await collect(anthropic({ apiKey: API_KEY, fetch, version: '2099-01-01' }).stream(REQUEST, new AbortController().signal));
    expect(requests[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(new Headers(requests[0]?.init.headers).get('anthropic-version')).toBe('2099-01-01');
  });

  it('streams with the default max_tokens and omits empty system and tools', async () => {
    expect(await bodyFor({ request: REQUEST })).toEqual({
      model: 'claude-test',
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('uses maxOutputTokens over defaultMaxTokens, and defaultMaxTokens over the built-in default', async () => {
    expect((await bodyFor({ request: { ...REQUEST, maxOutputTokens: 256 }, options: { defaultMaxTokens: 1000 } })).max_tokens).toBe(256);
    expect((await bodyFor({ request: REQUEST, options: { defaultMaxTokens: 1000 } })).max_tokens).toBe(1000);
  });

  it('joins system messages into one cached system block by default', async () => {
    const body = await bodyFor({
      request: { ...REQUEST, messages: [{ role: 'system', text: 'Rule one.' }, { role: 'user', text: 'hi' }, { role: 'system', text: 'Rule two.' }] },
    });
    expect(body.system).toEqual([{ type: 'text', text: 'Rule one.\n\nRule two.', cache_control: { type: 'ephemeral' } }]);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('sends the system prompt as a plain string when prompt caching is off', async () => {
    const body = await bodyFor({ request: { ...REQUEST, messages: [{ role: 'system', text: 'Be brief.' }, { role: 'user', text: 'hi' }] }, options: { promptCaching: false } });
    expect(body.system).toBe('Be brief.');
  });

  it('maps tools to input_schema without the strict flag', async () => {
    const parameters = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false };
    const body = await bodyFor({
      request: {
        ...REQUEST,
        tools: [
          { name: 'search', description: 'Search things', parameters, strict: true },
          { name: 'aigent_multi', description: 'Batch', parameters: { type: 'object' }, strict: false },
        ],
      },
    });
    expect(body.tools).toEqual([
      { name: 'search', description: 'Search things', input_schema: parameters },
      { name: 'aigent_multi', description: 'Batch', input_schema: { type: 'object' } },
    ]);
  });

  // The API wants roles to alternate and every result for a turn in one user message, results before any text.
  it('maps assistant tool calls to tool_use blocks and merges tool results and following user text into one user message', async () => {
    const body = await bodyFor({
      request: {
        ...REQUEST,
        messages: [
          { role: 'user', text: 'find cats' },
          {
            role: 'assistant',
            text: 'Searching.',
            toolCalls: [
              { id: 'c1', name: 'search', args: { q: 'cats' } },
              { id: 'c2', name: 'lookup', args: '{"id":"x"}' },
            ],
          },
          { role: 'tool', toolCallId: 'c1', text: '{"ok":true}' },
          { role: 'tool', toolCallId: 'c2', text: 'found x' },
          { role: 'user', text: 'and dogs?' },
          { role: 'user', text: 'and birds?' },
          { role: 'assistant', toolCalls: [{ id: 'c3', name: 'search', args: '{"q":"do' }, { id: 'c4', name: 'search', args: '[1]' }] },
          { role: 'tool', toolCallId: 'c3', text: 'bad args' },
          { role: 'tool', toolCallId: 'c4', text: 'bad args too' },
          { role: 'assistant', text: 'Done.' },
        ],
      },
    });
    expect(body.messages).toEqual([
      { role: 'user', content: 'find cats' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Searching.' },
          { type: 'tool_use', id: 'c1', name: 'search', input: { q: 'cats' } },
          { type: 'tool_use', id: 'c2', name: 'lookup', input: { id: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: '{"ok":true}' },
          { type: 'tool_result', tool_use_id: 'c2', content: 'found x' },
          { type: 'text', text: 'and dogs?' },
          { type: 'text', text: 'and birds?' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c3', name: 'search', input: {} },
          { type: 'tool_use', id: 'c4', name: 'search', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c3', content: 'bad args' },
          { type: 'tool_result', tool_use_id: 'c4', content: 'bad args too' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ]);
  });

  // The API rejects `content: []` and whitespace-only text blocks, so an assistant turn that said nothing is dropped
  // and the user messages around it merge to keep roles alternating.
  it('drops an assistant message with no tool calls and only whitespace text, merging the user messages around it', async () => {
    const body = await bodyFor({
      request: {
        ...REQUEST,
        messages: [
          { role: 'user', text: 'first' },
          { role: 'assistant', text: '' },
          { role: 'user', text: 'second' },
          { role: 'assistant', text: ' \n' },
          { role: 'assistant' },
          { role: 'user', text: 'third' },
        ],
      },
    });
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }, { type: 'text', text: 'third' }] },
    ]);
  });

  it('omits a whitespace-only text block before tool calls', async () => {
    const body = await bodyFor({
      request: {
        ...REQUEST,
        messages: [{ role: 'user', text: 'go' }, { role: 'assistant', text: '\n\n', toolCalls: [{ id: 'c1', name: 'search', args: {} }] }],
      },
    });
    expect(body.messages).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'search', input: {} }] },
    ]);
  });

  it('merges adjacent assistant messages into one', async () => {
    const body = await bodyFor({
      request: {
        ...REQUEST,
        messages: [
          { role: 'user', text: 'go' },
          { role: 'assistant', text: 'One.' },
          { role: 'assistant', text: 'Two.', toolCalls: [{ id: 'c1', name: 'search', args: {} }] },
        ],
      },
    });
    expect(body.messages).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'One.' }, { type: 'text', text: 'Two.' }, { type: 'tool_use', id: 'c1', name: 'search', input: {} }],
      },
    ]);
  });
});

describe('anthropic streaming', () => {
  it('streams interleaved text and two tool_use blocks, each call emitted as its block stops', async () => {
    const calls = [
      { id: 'toolu_b', name: 'lookup', args: { id: 'x-1', tags: ['a', 'b'] } },
      { id: 'toolu_a', name: 'search', args: { q: 'long query text with é', limit: 3 } },
    ];
    const events = await streaming([
      messageStart(),
      ...textBlock({ index: 0, chunks: ['Let me ', 'check.'] }),
      ...interleavedToolUseBlocks({ calls, firstIndex: 1 }),
      messageDelta({ stopReason: 'tool_use', outputTokens: 40 }),
      messageStop(),
    ]).events();
    expect(events).toEqual([
      { type: 'text-delta', text: 'Let me ' },
      { type: 'text-delta', text: 'check.' },
      { type: 'tool-call', call: calls[0] },
      { type: 'tool-call', call: calls[1] },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 40, cachedTokens: 0 } },
      { type: 'done', finishReason: 'tool_calls' },
    ]);
  });

  it('emits a tool call at its block stop, before later text', async () => {
    const events = await streaming([
      messageStart(),
      toolUseBlockStart({ index: 0, id: 't1', name: 'a' }),
      inputJsonDelta({ index: 0, partialJson: '{"x":' }),
      textBlockStart(1),
      inputJsonDelta({ index: 0, partialJson: '1}' }),
      blockStop(0),
      textDelta({ index: 1, text: 'after' }),
      blockStop(1),
      messageDelta({ stopReason: 'tool_use', outputTokens: 3 }),
      messageStop(),
    ]).events();
    expect(events.slice(0, 2)).toEqual([
      { type: 'tool-call', call: { id: 't1', name: 'a', args: { x: 1 } } },
      { type: 'text-delta', text: 'after' },
    ]);
  });

  it('turns thinking deltas into thinking events', async () => {
    const events = await streaming([
      messageStart(),
      thinkingBlockStart(0),
      thinkingDelta({ index: 0, thinking: 'hmm ' }),
      thinkingDelta({ index: 0, thinking: 'ok' }),
      blockStop(0),
      ...textBlock({ index: 1, chunks: ['Hi'] }),
      messageDelta({ stopReason: 'end_turn', outputTokens: 0 }),
      messageStop(),
    ]).events();
    expect(events).toEqual([
      { type: 'thinking-delta', text: 'hmm ' },
      { type: 'thinking-delta', text: 'ok' },
      { type: 'text-delta', text: 'Hi' },
      ZERO_USAGE,
      DONE_STOP,
    ]);
  });

  it('passes malformed tool JSON through as the raw string and empty JSON as {}', async () => {
    const events = await streaming([
      messageStart(),
      toolUseBlockStart({ index: 0, id: 't1', name: 'a' }),
      inputJsonDelta({ index: 0, partialJson: '{"q": "unterminated' }),
      blockStop(0),
      toolUseBlockStart({ index: 1, id: 't2', name: 'b' }),
      blockStop(1),
      messageDelta({ stopReason: 'tool_use', outputTokens: 0 }),
      messageStop(),
    ]).events();
    expect(events.filter(event => event.type === 'tool-call')).toEqual([
      { type: 'tool-call', call: { id: 't1', name: 'a', args: '{"q": "unterminated' } },
      { type: 'tool-call', call: { id: 't2', name: 'b', args: {} } },
    ]);
  });

  it('reports cache reads and writes as input and cache reads as cached', async () => {
    const events = await streaming([
      messageStart({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
      ...textBlock({ index: 0, chunks: ['x'] }),
      messageDelta({ stopReason: 'end_turn', outputTokens: 25 }),
      messageStop(),
    ]).events();
    expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', usage: { inputTokens: 240, outputTokens: 25, cachedTokens: 200 } }]);
  });

  it('treats missing cache fields as zero', async () => {
    const events = await streaming([messageStart({ input_tokens: 9 }), messageDelta({ stopReason: 'end_turn', outputTokens: 1 }), messageStop()]).events();
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 9, outputTokens: 1, cachedTokens: 0 } });
  });

  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['tool_use', 'tool_calls'],
    ['max_tokens', 'length'],
    ['refusal', 'stop'],
  ])('maps stop_reason %s to %s', async (stopReason, finishReason) => {
    const events = await streaming([messageStart(), messageDelta({ stopReason, outputTokens: 0 }), messageStop()]).events();
    expect(events.at(-1)).toEqual({ type: 'done', finishReason });
  });

  it('ignores ping and unknown events', async () => {
    const unknown: AnthropicEventFixture = { event: 'future_event', data: { type: 'future_event', detail: 1 } };
    const events = await streaming([ping(), messageStart(), unknown, ...textBlock({ index: 0, chunks: ['x'] }), ping(), ...EMPTY_TURN.slice(1)]).events();
    expect(events).toEqual([{ type: 'text-delta', text: 'x' }, ZERO_USAGE, DONE_STOP]);
  });

  it('parses identically when the body arrives one byte at a time', async () => {
    const text = anthropicSse([
      messageStart(),
      ...textBlock({ index: 0, chunks: ['日本 😀 é'] }),
      ...interleavedToolUseBlocks({ calls: [{ id: 't1', name: 'x', args: { a: 'é' } }], firstIndex: 1 }),
      messageDelta({ stopReason: 'tool_use', outputTokens: 2 }),
      messageStop(),
    ]).replaceAll('\n', '\r\n');
    const whole = await harness({ respond: () => ({ body: createFakeBody({ chunks: [encodeText(text)] }) }) }).events();
    const byteByByte = await harness({ respond: () => chunked(text, 1) }).events();
    expect(byteByByte).toEqual(whole);
    expect(whole).toContainEqual({ type: 'text-delta', text: '日本 😀 é' });
    expect(whole).toContainEqual({ type: 'tool-call', call: { id: 't1', name: 'x', args: { a: 'é' } } });
  });

  it('fails with the error type and message when the server streams an error event', async () => {
    const error = await streaming([messageStart(), textBlockStart(0), errorEvent({ errorType: 'overloaded_error', message: 'Overloaded' })]).error();
    expect(error.code).toBe('provider_failed');
    expect(error.message).toContain('anthropic');
    expect(error.message).toContain('overloaded_error');
    expect(error.message).toContain('Overloaded');
    expect(error.details).toMatchObject({ errorType: 'overloaded_error', retryable: true });
  });

  it('marks streamed request errors as not retryable', async () => {
    const error = await streaming([errorEvent({ errorType: 'invalid_request_error', message: 'bad' })]).error();
    expect(error.details).toMatchObject({ errorType: 'invalid_request_error', retryable: false });
  });

  it('fails when the stream ends before message_stop', async () => {
    const error = await streaming([messageStart(), ...textBlock({ index: 0, chunks: ['x'] }), messageDelta({ stopReason: 'end_turn', outputTokens: 1 })]).error();
    expect(error.code).toBe('provider_failed');
    expect(error.message).toContain('stream ended before completion');
  });

  it('fails when a payload is JSON but not an object', async () => {
    const error = await harness({ respond: () => chunked('event: message_start\ndata: 42\n\n') }).error();
    expect(error.code).toBe('provider_failed');
    expect(error.message).toContain('anthropic');
  });

  it('fails when input JSON arrives for a block that is not a tool_use block', async () => {
    const error = await streaming([messageStart(), textBlockStart(0), inputJsonDelta({ index: 0, partialJson: '{}' })]).error();
    expect(error.code).toBe('provider_failed');
    expect(error.message).toContain('block 0');
  });
});

describe('anthropic errors', () => {
  it.each([
    [400, false], [401, false], [429, true], [500, true], [529, true],
  ])('HTTP %i fails with retryable %s and never leaks the key', async (status, retryable) => {
    const body = `{"type":"error","error":{"type":"x","message":"nope"},"key":"${API_KEY}"}`;
    const error = await harness({ respond: () => ({ status, body }) }).error();
    expect(error.code).toBe('provider_failed');
    expect(error.details).toMatchObject({ status, retryable, body });
    expect(error.message).toContain('anthropic');
    expect(error.message).toContain(String(status));
    expect(error.message).not.toContain(API_KEY);
  });

  it('maps a fetch rejection to provider_failed with the cause, without the key', async () => {
    const provider = anthropic({ apiKey: API_KEY, fetch: () => Promise.reject(new TypeError('getaddrinfo ENOTFOUND api.anthropic.com')) });
    const error = await captureError(collect(provider.stream(REQUEST, new AbortController().signal)));
    expect(error.code).toBe('provider_failed');
    expect(error.message).toContain('ENOTFOUND');
    expect(error.message).not.toContain(API_KEY);
  });

  it('maps a mid-stream network error to provider_failed and never hangs', async () => {
    const body = createFakeBody({ chunks: [encodeText(anthropicSse([messageStart(), textBlockStart(0)]))], ending: 'error' });
    const error = await harness({ respond: () => ({ body }) }).error();
    expect(error.code).toBe('provider_failed');
    expect(error.message).toContain('socket hang up');
  });
});

describe('anthropic abort and cancellation', () => {
  function hangingBody(): FakeBody {
    return createFakeBody({ chunks: [encodeText(anthropicSse([messageStart(), textBlockStart(0), textDelta({ index: 0, text: 'a' })]))], ending: 'hang' });
  }

  it('throws aborted at once when the signal is already aborted, without calling fetch', async () => {
    const { fetch, requests } = createFakeFetch(() => ({ body: hangingBody() }));
    const controller = new AbortController();
    controller.abort();
    const error = await captureError(collect(anthropic({ apiKey: API_KEY, fetch }).stream(REQUEST, controller.signal)));
    expect(error.code).toBe('aborted');
    expect(requests).toHaveLength(0);
  });

  it('stops reading a body that never ends, cancels it and throws aborted', async () => {
    const body = hangingBody();
    const { fetch } = createFakeFetch(() => ({ body }));
    const controller = new AbortController();
    const seen: ProviderEvent[] = [];
    const run = (async (): Promise<void> => {
      for await (const event of anthropic({ apiKey: API_KEY, fetch }).stream(REQUEST, controller.signal)) {
        seen.push(event);
        // Abort while the adapter is waiting on a read that would otherwise never complete.
        setTimeout(() => controller.abort(), 10);
      }
    })();
    const error = await captureError(run);
    expect(error.code).toBe('aborted');
    expect(seen).toEqual([{ type: 'text-delta', text: 'a' }]);
    expect(body.isCancelled()).toBe(true);
  });

  it('yields nothing more after an abort, even events from the same SSE message', async () => {
    // `message_stop` produces both usage and done; aborting on usage must suppress done.
    const { fetch } = createFakeFetch(() => chunked(anthropicSse([messageStart(), ...textBlock({ index: 0, chunks: ['x'] }), ...EMPTY_TURN.slice(1)])));
    const controller = new AbortController();
    const seen: ProviderEvent[] = [];
    const run = (async (): Promise<void> => {
      for await (const event of anthropic({ apiKey: API_KEY, fetch }).stream(REQUEST, controller.signal)) {
        seen.push(event);
        if (event.type === 'usage') controller.abort();
      }
    })();
    const error = await captureError(run);
    expect(error.code).toBe('aborted');
    expect(seen.at(-1)?.type).toBe('usage');
  });

  it('cancels the body when the consumer stops early', async () => {
    const body = hangingBody();
    const { fetch } = createFakeFetch(() => ({ body }));
    for await (const event of anthropic({ apiKey: API_KEY, fetch }).stream(REQUEST, new AbortController().signal)) {
      if (event.type === 'text-delta') break;
    }
    expect(body.isCancelled()).toBe(true);
  });
});

describe('anthropic capabilities', () => {
  it('defaults to id anthropic, prompt caching and a 200k context', () => {
    const provider = anthropic({ apiKey: API_KEY });
    expect(provider.id).toBe('anthropic');
    expect(provider.capabilities).toEqual({
      streaming: true, toolCalling: true, parallelToolCalls: true, promptCaching: true, vision: false, maxContextTokens: 200_000,
    });
  });

  it('reflects promptCaching and maxContextTokens options', () => {
    const { capabilities } = anthropic({ apiKey: API_KEY, promptCaching: false, maxContextTokens: 1_000_000 });
    expect(capabilities).toMatchObject({ promptCaching: false, maxContextTokens: 1_000_000 });
  });
});
