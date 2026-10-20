// Test-only builders for Anthropic Messages API SSE bodies. Excluded from the build; never exported.
import { chunkBytes } from '../testing/contract/index.js';
import type { ContractScenario } from '../testing/contract/index.js';
import { createFakeBody, encodeText } from './fake-fetch.test-support.js';
import type { FakeResponseSpec, RecordedRequest } from './fake-fetch.test-support.js';
import type { ThinkingBlock, ToolCall, Usage } from './provider-types.js';

/** One SSE message: the `event:` name plus its JSON payload (whose `type` repeats the name, as Anthropic sends it). */
export interface AnthropicEventFixture {
  event: string;
  data: Record<string, unknown>;
}

export interface AnthropicUsageFixture {
  input_tokens: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Bytes per network chunk for contract fixtures: small enough to cut lines and JSON mid-way. */
const NETWORK_CHUNK_BYTES = 7;
/** Characters per `partial_json` fragment, so every call's JSON spans many SSE messages. */
const JSON_FRAGMENT_LENGTH = 3;
const HTTP_ERROR_BODY = '{"type":"error","error":{"type":"api_error","message":"contract failure"}}';
const MALFORMED_CALL_ID = 'toolu_malformed';
const ZERO_INPUT_USAGE: AnthropicUsageFixture = { input_tokens: 0, output_tokens: 0 };
/** The Messages API's answer to a tool_use turn replayed without its thinking blocks while thinking is on. */
const MISSING_THINKING_BODY = '{"type":"error","error":{"type":"invalid_request_error","message":"Expected `thinking` or `redacted_thinking`, but found `tool_use`."}}';
const BAD_REQUEST_STATUS = 400;

/** Which request of a scenario a response answers, for scenarios that span several requests. */
export interface ScenarioExchange {
  request: RecordedRequest;
  /** 0 for the first request served to the provider. */
  callIndex: number;
}

function fixture(params: { type: string; fields: Record<string, unknown> }): AnthropicEventFixture {
  const { type, fields } = params;
  return { event: type, data: { type, ...fields } };
}

/** Serialises events as `event:`/`data:` pairs, the way the Messages API streams them. */
export function anthropicSse(events: AnthropicEventFixture[]): string {
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

export function messageStart(usage: AnthropicUsageFixture = ZERO_INPUT_USAGE): AnthropicEventFixture {
  return fixture({
    type: 'message_start',
    fields: { message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-test', stop_reason: null, usage } },
  });
}

export function textBlockStart(index: number): AnthropicEventFixture {
  return fixture({ type: 'content_block_start', fields: { index, content_block: { type: 'text', text: '' } } });
}

export function thinkingBlockStart(index: number): AnthropicEventFixture {
  return fixture({ type: 'content_block_start', fields: { index, content_block: { type: 'thinking', thinking: '' } } });
}

export function redactedThinkingBlockStart(params: { index: number; data: string }): AnthropicEventFixture {
  const { index, data } = params;
  return fixture({ type: 'content_block_start', fields: { index, content_block: { type: 'redacted_thinking', data } } });
}

export function signatureDelta(params: { index: number; signature: string }): AnthropicEventFixture {
  const { index, signature } = params;
  return fixture({ type: 'content_block_delta', fields: { index, delta: { type: 'signature_delta', signature } } });
}

/** A whole thinking block as the API streams it: start, thinking deltas, the signature, stop. */
export function thinkingBlock(params: { index: number; chunks: string[]; signature: string }): AnthropicEventFixture[] {
  const { index, chunks, signature } = params;
  return [thinkingBlockStart(index), ...chunks.map(thinking => thinkingDelta({ index, thinking })), signatureDelta({ index, signature }), blockStop(index)];
}

/** A redacted thinking block: its encrypted `data` arrives whole in the start event. */
export function redactedThinkingBlock(params: { index: number; data: string }): AnthropicEventFixture[] {
  const { index } = params;
  return [redactedThinkingBlockStart(params), blockStop(index)];
}

export function toolUseBlockStart(params: { index: number; id: string; name: string }): AnthropicEventFixture {
  const { index, id, name } = params;
  return fixture({ type: 'content_block_start', fields: { index, content_block: { type: 'tool_use', id, name, input: {} } } });
}

export function textDelta(params: { index: number; text: string }): AnthropicEventFixture {
  const { index, text } = params;
  return fixture({ type: 'content_block_delta', fields: { index, delta: { type: 'text_delta', text } } });
}

export function thinkingDelta(params: { index: number; thinking: string }): AnthropicEventFixture {
  const { index, thinking } = params;
  return fixture({ type: 'content_block_delta', fields: { index, delta: { type: 'thinking_delta', thinking } } });
}

export function inputJsonDelta(params: { index: number; partialJson: string }): AnthropicEventFixture {
  const { index, partialJson } = params;
  return fixture({ type: 'content_block_delta', fields: { index, delta: { type: 'input_json_delta', partial_json: partialJson } } });
}

export function blockStop(index: number): AnthropicEventFixture {
  return fixture({ type: 'content_block_stop', fields: { index } });
}

export function messageDelta(params: { stopReason: string; outputTokens: number }): AnthropicEventFixture {
  const { stopReason, outputTokens } = params;
  return fixture({ type: 'message_delta', fields: { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } } });
}

export function messageStop(): AnthropicEventFixture {
  return fixture({ type: 'message_stop', fields: {} });
}

export function ping(): AnthropicEventFixture {
  return fixture({ type: 'ping', fields: {} });
}

export function errorEvent(params: { errorType: string; message: string }): AnthropicEventFixture {
  const { errorType, message } = params;
  return fixture({ type: 'error', fields: { error: { type: errorType, message } } });
}

/** Contract usage → wire usage: Anthropic reports cached reads separately from uncached input. */
export function toAnthropicUsage(usage: Usage): AnthropicUsageFixture {
  const { inputTokens, cachedTokens } = usage;
  return { input_tokens: inputTokens - cachedTokens, output_tokens: 1, cache_read_input_tokens: cachedTokens, cache_creation_input_tokens: 0 };
}

function fragments(text: string): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += JSON_FRAGMENT_LENGTH) pieces.push(text.slice(start, start + JSON_FRAGMENT_LENGTH));
  return pieces;
}

export interface ToolUseBlocksParams {
  calls: ToolCall[];
  firstIndex: number;
  /** Each call's `partial_json` fragments; split into `JSON_FRAGMENT_LENGTH` pieces when omitted. */
  jsonFragments?: string[][];
}

/**
 * Opens one `tool_use` block per call (block indexes from `firstIndex`), interleaves every block's `partial_json`
 * fragments round-robin, then stops the blocks in order. Stronger than the API's sequential blocks on purpose.
 */
export function interleavedToolUseBlocks(params: ToolUseBlocksParams): AnthropicEventFixture[] {
  const { calls, firstIndex, jsonFragments = calls.map(({ args }) => fragments(typeof args === 'string' ? args : JSON.stringify(args))) } = params;
  const openings = calls.map(({ id, name }, offset) => toolUseBlockStart({ index: firstIndex + offset, id, name }));
  const longest = Math.max(0, ...jsonFragments.map(callFragments => callFragments.length));
  const interleaved: AnthropicEventFixture[] = [];
  for (let position = 0; position < longest; position += 1) {
    jsonFragments.forEach((callFragments, offset) => {
      const partialJson = callFragments[position];
      if (partialJson != null) interleaved.push(inputJsonDelta({ index: firstIndex + offset, partialJson }));
    });
  }
  const stops = calls.map((_call, offset) => blockStop(firstIndex + offset));
  return [...openings, ...interleaved, ...stops];
}

/** A whole text answer as one text block. */
export function textBlock(params: { index: number; chunks: string[] }): AnthropicEventFixture[] {
  const { index, chunks } = params;
  return [textBlockStart(index), ...chunks.map(text => textDelta({ index, text })), blockStop(index)];
}

/** A normalised thinking block as the API streams it. */
function streamedThinkingBlock(params: { index: number; block: ThinkingBlock }): AnthropicEventFixture[] {
  const { index, block } = params;
  if (block.type === 'redacted-thinking') return redactedThinkingBlock({ index, data: block.data });
  return thinkingBlock({ index, chunks: fragments(block.thinking), signature: block.signature });
}

/** A normalised thinking block as the API wants it replayed. */
function wireThinkingBlock(block: ThinkingBlock): Record<string, unknown> {
  return block.type === 'redacted-thinking' ? { type: 'redacted_thinking', data: block.data } : { type: 'thinking', thinking: block.thinking, signature: block.signature };
}

/** Serves the round trip: thinking then the call; then the answer, or a 400 unless the blocks were replayed unmodified before the call. */
function roundTripResponse(params: { scenario: Extract<ContractScenario, { kind: 'thinking-round-trip' }>; exchange?: ScenarioExchange }): FakeResponseSpec {
  const { scenario: { blocks, call, answer, usage }, exchange } = params;
  if (exchange == null || exchange.callIndex === 0) {
    return chunkedResponse([
      messageStart(toAnthropicUsage(usage)),
      ...blocks.flatMap((block, index) => streamedThinkingBlock({ index, block })),
      ...interleavedToolUseBlocks({ calls: [call], firstIndex: blocks.length }),
      messageDelta({ stopReason: 'tool_use', outputTokens: usage.outputTokens }), messageStop(),
    ]);
  }
  const { messages } = JSON.parse(String(exchange.request.init.body)) as { messages: { role: string; content: unknown }[] };
  const assistant = messages.find(({ role }) => role === 'assistant');
  const expected = [...blocks.map(wireThinkingBlock), { type: 'tool_use', id: call.id, name: call.name, input: call.args }];
  if (JSON.stringify(assistant?.content) !== JSON.stringify(expected)) return { status: BAD_REQUEST_STATUS, body: MISSING_THINKING_BODY };
  return chunkedResponse([
    messageStart(toAnthropicUsage(usage)), ...textBlock({ index: 0, chunks: answer }),
    messageDelta({ stopReason: 'end_turn', outputTokens: usage.outputTokens }), messageStop(),
  ]);
}

function chunkedResponse(events: AnthropicEventFixture[]): FakeResponseSpec {
  return { body: createFakeBody({ chunks: chunkBytes(anthropicSse(events), NETWORK_CHUNK_BYTES) }) };
}

/** Converts a contract scenario into the HTTP response the Anthropic Messages API would send for it. */
export function anthropicScenarioResponse(scenario: ContractScenario, exchange?: ScenarioExchange): FakeResponseSpec {
  switch (scenario.kind) {
    case 'thinking-round-trip':
      return roundTripResponse({ scenario, ...(exchange == null ? {} : { exchange }) });
    case 'text': {
      const { chunks, usage } = scenario;
      return chunkedResponse([
        messageStart(toAnthropicUsage(usage)), ping(), ...textBlock({ index: 0, chunks }),
        messageDelta({ stopReason: 'end_turn', outputTokens: usage.outputTokens }), messageStop(),
      ]);
    }
    case 'tool-calls': {
      const { calls, argumentFragments, usage } = scenario;
      return chunkedResponse([
        messageStart(toAnthropicUsage(usage)), ...interleavedToolUseBlocks({ calls, firstIndex: 0, jsonFragments: argumentFragments }),
        messageDelta({ stopReason: 'tool_use', outputTokens: usage.outputTokens }), messageStop(),
      ]);
    }
    case 'malformed-tool-args': {
      const { name, rawArgs, rawArgsFragments } = scenario;
      const calls = [{ id: MALFORMED_CALL_ID, name, args: rawArgs }];
      return chunkedResponse([
        messageStart(), ...interleavedToolUseBlocks({ calls, firstIndex: 0, jsonFragments: [rawArgsFragments] }),
        messageDelta({ stopReason: 'tool_use', outputTokens: 0 }), messageStop(),
      ]);
    }
    case 'thinking': {
      const { thinking, chunks, usage } = scenario;
      return chunkedResponse([
        messageStart(toAnthropicUsage(usage)),
        thinkingBlockStart(0), ...thinking.map(text => thinkingDelta({ index: 0, thinking: text })), blockStop(0),
        ...textBlock({ index: 1, chunks }),
        messageDelta({ stopReason: 'end_turn', outputTokens: usage.outputTokens }), messageStop(),
      ]);
    }
    case 'length': {
      const { chunks, usage } = scenario;
      return chunkedResponse([
        messageStart(toAnthropicUsage(usage)), ...textBlock({ index: 0, chunks }),
        messageDelta({ stopReason: 'max_tokens', outputTokens: usage.outputTokens }), messageStop(),
      ]);
    }
    case 'http-error':
      return { status: scenario.status, body: HTTP_ERROR_BODY };
    case 'truncated-stream':
      return chunkedResponse([messageStart(), textBlockStart(0), textDelta({ index: 0, text: 'cut ' }), textDelta({ index: 0, text: 'short' })]);
    case 'network-error': {
      const events = [messageStart(), textBlockStart(0), ...scenario.chunks.map(text => textDelta({ index: 0, text }))];
      return { body: createFakeBody({ chunks: chunkBytes(anthropicSse(events), NETWORK_CHUNK_BYTES), ending: 'error' }) };
    }
    case 'slow-text': {
      const { chunks, delayMs } = scenario;
      const events = [messageStart(), ...textBlock({ index: 0, chunks }), messageDelta({ stopReason: 'end_turn', outputTokens: 1 }), messageStop()];
      return { body: createFakeBody({ chunks: events.map(event => encodeText(anthropicSse([event]))), delayMs }) };
    }
  }
}
