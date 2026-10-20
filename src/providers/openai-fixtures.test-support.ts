// Test-only builders for OpenAI-style `chat.completion.chunk` SSE bodies. Excluded from the build; never exported.
import type { ContractScenario } from '../testing/contract/index.js';
import type { ToolCall, Usage } from './provider-types.js';
import { byteChunks, createFakeBody, encodeText } from './fake-fetch.test-support.js';
import type { FakeResponseSpec } from './fake-fetch.test-support.js';

export interface ToolCallDeltaFixture {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface OpenAiUsageFixture {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  prompt_cache_hit_tokens?: number;
}

const DONE_DATA = '[DONE]';
/** Bytes per network chunk for contract fixtures: small enough to cut lines and JSON mid-way. */
const NETWORK_CHUNK_BYTES = 7;
/** Characters per `arguments` fragment, so every call's JSON spans many SSE messages. */
const ARGUMENT_FRAGMENT_LENGTH = 3;
const SLOW_CHUNK_DELAY_MS = 20;
const HTTP_ERROR_BODY = '{"error":{"message":"contract failure"}}';
const MALFORMED_CALL_ID = 'call_malformed';

/** Joins JSON payloads into an SSE body ending with `data: [DONE]`. */
export function sseBody(events: string[]): string {
  return [...events, DONE_DATA].map(data => `data: ${data}\n\n`).join('');
}

/** Same as `sseBody` but without `[DONE]`, for streams cut short. */
export function sseBodyWithoutDone(events: string[]): string {
  return events.map(data => `data: ${data}\n\n`).join('');
}

function chunk(choice: Record<string, unknown>): string {
  return JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }] });
}

export function textChunk(text: string): string {
  return chunk({ delta: { content: text }, finish_reason: null });
}

export function reasoningChunk(params: { field: 'reasoning_content' | 'reasoning'; text: string }): string {
  const { field, text } = params;
  return chunk({ delta: { [field]: text }, finish_reason: null });
}

export function toolCallChunk(deltas: ToolCallDeltaFixture[]): string {
  const toolCalls = deltas.map(({ index, id, name, arguments: args }) => ({
    index,
    ...(id == null ? {} : { id, type: 'function' }),
    function: { ...(name == null ? {} : { name }), ...(args == null ? {} : { arguments: args }) },
  }));
  return chunk({ delta: { tool_calls: toolCalls }, finish_reason: null });
}

export function finishChunk(reason: string): string {
  return chunk({ delta: {}, finish_reason: reason });
}

/** The final usage-only chunk OpenAI sends when `stream_options.include_usage` is set (empty `choices`). */
export function usageChunk(usage: OpenAiUsageFixture): string {
  return JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [], usage });
}

export function toOpenAiUsage(usage: Usage): OpenAiUsageFixture {
  const { inputTokens, outputTokens, cachedTokens } = usage;
  return { prompt_tokens: inputTokens, completion_tokens: outputTokens, prompt_tokens_details: { cached_tokens: cachedTokens } };
}

function fragments(text: string): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += ARGUMENT_FRAGMENT_LENGTH) pieces.push(text.slice(start, start + ARGUMENT_FRAGMENT_LENGTH));
  return pieces;
}

/**
 * Streams several calls the way parallel tool calling does: every call opens with its id and name, then the argument
 * fragments of all calls are interleaved round-robin, one SSE message per fragment.
 */
export function interleavedToolCallChunks(calls: ToolCall[]): string[] {
  const openings = calls.map(({ id, name }, index) => toolCallChunk([{ index, id, name, arguments: '' }]));
  const argumentFragments = calls.map(({ args }) => fragments(typeof args === 'string' ? args : JSON.stringify(args)));
  const longest = Math.max(0, ...argumentFragments.map(callFragments => callFragments.length));
  const interleaved: string[] = [];
  for (let position = 0; position < longest; position += 1) {
    argumentFragments.forEach((callFragments, index) => {
      const fragment = callFragments[position];
      if (fragment != null) interleaved.push(toolCallChunk([{ index, arguments: fragment }]));
    });
  }
  return [...openings, ...interleaved];
}

function chunkedResponse(text: string): FakeResponseSpec {
  return { body: createFakeBody({ chunks: byteChunks({ text, size: NETWORK_CHUNK_BYTES }) }) };
}

/** Converts a contract scenario into the HTTP response an OpenAI-compatible server would send for it. */
export function openAiScenarioResponse(scenario: ContractScenario): FakeResponseSpec {
  switch (scenario.kind) {
    case 'text': {
      const { chunks, usage } = scenario;
      return chunkedResponse(sseBody([...chunks.map(textChunk), finishChunk('stop'), usageChunk(toOpenAiUsage(usage))]));
    }
    case 'tool-calls': {
      const { calls, usage } = scenario;
      return chunkedResponse(sseBody([...interleavedToolCallChunks(calls), finishChunk('tool_calls'), usageChunk(toOpenAiUsage(usage))]));
    }
    case 'malformed-tool-args': {
      const { name, rawArgs } = scenario;
      return chunkedResponse(sseBody([...interleavedToolCallChunks([{ id: MALFORMED_CALL_ID, name, args: rawArgs }]), finishChunk('tool_calls')]));
    }
    case 'http-error':
      return { status: scenario.status, body: HTTP_ERROR_BODY };
    case 'truncated-stream':
      return chunkedResponse(sseBodyWithoutDone([textChunk('cut '), textChunk('short')]));
    case 'slow-text': {
      const events = sseBody([...scenario.chunks.map(textChunk), finishChunk('stop')]).split(/(?<=\n\n)/);
      return { body: createFakeBody({ chunks: events.map(encodeText), delayMs: SLOW_CHUNK_DELAY_MS }) };
    }
  }
}
