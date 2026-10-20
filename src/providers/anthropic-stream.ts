import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import type { AigentError } from '../core/aigent-error.js';
import type { FinishReason, ProviderEvent, ThinkingBlock, ToolCall, Usage } from './provider-types.js';
import type { SseMessage } from './sse-parser.js';

/** A `tool_use` content block being assembled from `input_json_delta` fragments. */
interface ToolUseDraft {
  id: string;
  name: string;
  json: string;
}

/** Input-side token counts from `message_start`; Anthropic reports cache reads and writes apart from uncached input. */
interface InputUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Everything remembered while reading one Anthropic stream; mutated by `applyAnthropicMessage`. */
export interface AnthropicStreamState {
  providerId: string;
  /** Open `tool_use` blocks by content block index. */
  toolBlocks: Map<number, ToolUseDraft>;
  /** Open `thinking` / `redacted_thinking` blocks by content block index, assembled from deltas and emitted whole at their stop. */
  thinkingBlocks: Map<number, ThinkingBlock>;
  inputUsage: InputUsage;
  outputTokens: number;
  /** False until the server reports any usage; without it no `usage` event is emitted rather than invented zeros. */
  hasUsage: boolean;
  /** Raw `stop_reason` from `message_delta`, once one arrives. */
  stopReason?: string;
  isComplete: boolean;
}

/** Wire `stop_reason` → normalised reason; anything else (e.g. `refusal`, `pause_turn`) is treated as `stop`. */
const FINISH_REASONS: ReadonlyMap<string, FinishReason> = new Map<string, FinishReason>([
  ['end_turn', 'stop'],
  ['stop_sequence', 'stop'],
  ['tool_use', 'tool_calls'],
  ['max_tokens', 'length'],
  // The answer was cut off by the context window rather than `max_tokens`; still incomplete.
  ['model_context_window_exceeded', 'length'],
]);
/** Streamed error types that describe a transient server condition rather than a bad request. */
const RETRYABLE_ERROR_TYPES: readonly string[] = ['overloaded_error', 'api_error', 'rate_limit_error', 'timeout_error'];
const UNKNOWN_ERROR_TYPE = 'unknown_error';
const NO_ERROR_MESSAGE = 'no message';
const TOOL_USE_BLOCK_TYPE = 'tool_use';
const THINKING_BLOCK_TYPE = 'thinking';
const REDACTED_THINKING_BLOCK_TYPE = 'redacted_thinking';
/** Longest slice of a bad payload quoted in an error message. */
const MAX_QUOTED_PAYLOAD_CHARS = 200;

// Only the fields we read; everything nullish so new or omitted fields never break parsing.
const usageSchema = z.object({
  input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
});

const eventSchema = z.object({
  type: z.string().nullish(),
  index: z.number().int().nonnegative().nullish(),
  message: z.object({ usage: usageSchema.nullish() }).nullish(),
  content_block: z.object({
    type: z.string(),
    id: z.string().nullish(),
    name: z.string().nullish(),
    thinking: z.string().nullish(),
    signature: z.string().nullish(),
    data: z.string().nullish(),
  }).nullish(),
  delta: z.object({
    type: z.string().nullish(),
    text: z.string().nullish(),
    thinking: z.string().nullish(),
    signature: z.string().nullish(),
    partial_json: z.string().nullish(),
    stop_reason: z.string().nullish(),
  }).nullish(),
  usage: usageSchema.nullish(),
  error: z.object({ type: z.string().nullish(), message: z.string().nullish() }).nullish(),
});

type AnthropicEvent = z.infer<typeof eventSchema>;

export function createAnthropicStreamState(providerId: string): AnthropicStreamState {
  return {
    providerId,
    toolBlocks: new Map(),
    thinkingBlocks: new Map(),
    inputUsage: { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    outputTokens: 0,
    hasUsage: false,
    isComplete: false,
  };
}

interface StreamErrorParams {
  state: AnthropicStreamState;
  problem: string;
  details?: Record<string, unknown>;
}

function streamError(params: StreamErrorParams): AigentError {
  const { state, problem, details } = params;
  return createAigentError({ code: 'provider_failed', message: `Provider '${state.providerId}' ${problem}`, ...(details == null ? {} : { details }) });
}

/** Returns the parsed payload, or `undefined` for non-JSON payloads (keep-alives) that are safe to skip. */
function parsePayload(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function readEvent(params: { state: AnthropicStreamState; data: string }): AnthropicEvent | undefined {
  const { state, data } = params;
  const payload = parsePayload(data);
  if (payload === undefined) return undefined;
  const quoted = data.slice(0, MAX_QUOTED_PAYLOAD_CHARS);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw streamError({ state, problem: `sent a stream payload that is not a JSON object: ${quoted}` });
  }
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) throw streamError({ state, problem: `sent an unexpected event shape (${parsed.error.message}): ${quoted}` });
  return parsed.data;
}

function rememberInputUsage(params: { state: AnthropicStreamState; event: AnthropicEvent }): void {
  const { state, event } = params;
  const usage = event.message?.usage;
  if (usage == null) return;
  state.hasUsage = true;
  state.inputUsage = {
    inputTokens: usage.input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
  state.outputTokens = usage.output_tokens ?? state.outputTokens;
}

function startBlock(params: { state: AnthropicStreamState; event: AnthropicEvent }): void {
  const { state, event } = params;
  const { index, content_block: block } = event;
  // Text blocks need no state: their deltas are emitted as they arrive.
  if (index == null || block == null) return;
  switch (block.type) {
    case TOOL_USE_BLOCK_TYPE:
      state.toolBlocks.set(index, { id: block.id ?? '', name: block.name ?? '', json: '' });
      return;
    case THINKING_BLOCK_TYPE:
      state.thinkingBlocks.set(index, { type: 'thinking', thinking: block.thinking ?? '', signature: block.signature ?? '' });
      return;
    case REDACTED_THINKING_BLOCK_TYPE:
      state.thinkingBlocks.set(index, { type: 'redacted-thinking', data: block.data ?? '' });
      return;
  }
}

/** Thinking text and the signature are kept exactly as streamed: the API rejects a replayed block that differs. */
function appendThinking(params: { state: AnthropicStreamState; index: number | undefined; thinking?: string; signature?: string }): void {
  const { state, index, thinking, signature } = params;
  const draft = index == null ? undefined : state.thinkingBlocks.get(index);
  if (draft?.type !== 'thinking') return;
  if (thinking != null) draft.thinking += thinking;
  if (signature != null) draft.signature += signature;
}

function appendToolJson(params: { state: AnthropicStreamState; index: number | undefined; partialJson: string }): void {
  const { state, index, partialJson } = params;
  const draft = index == null ? undefined : state.toolBlocks.get(index);
  if (draft == null) throw streamError({ state, problem: `streamed input JSON for content block ${index ?? '(no index)'}, which is not an open tool_use block` });
  draft.json += partialJson;
}

function applyDelta(params: { state: AnthropicStreamState; event: AnthropicEvent }): ProviderEvent[] {
  const { state, event } = params;
  const { index, delta } = event;
  if (delta == null) return [];
  const { text, thinking, signature, partial_json: partialJson } = delta;
  if (partialJson != null) appendToolJson({ state, index: index ?? undefined, partialJson });
  if (thinking != null || signature != null) {
    appendThinking({ state, index: index ?? undefined, ...(thinking == null ? {} : { thinking }), ...(signature == null ? {} : { signature }) });
  }
  const events: ProviderEvent[] = [];
  if (thinking != null && thinking !== '') events.push({ type: 'thinking-delta', text: thinking });
  if (text != null && text !== '') events.push({ type: 'text-delta', text });
  return events;
}

/** Malformed JSON stays a raw string so tool argument validation can report a precise, retryable error. */
function parseToolInput(json: string): unknown {
  if (json.trim() === '') return {};
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

function toToolCallEvent(draft: ToolUseDraft): ProviderEvent {
  const { id, name, json } = draft;
  const call: ToolCall = { id, name, args: parseToolInput(json) };
  return { type: 'tool-call', call };
}

/**
 * A tool call or thinking block is complete once its block stops, so it is emitted right away rather than at the end
 * of the turn.
 */
function stopBlock(params: { state: AnthropicStreamState; event: AnthropicEvent }): ProviderEvent[] {
  const { state, event } = params;
  const { index } = event;
  if (index == null) return [];
  const thinking = state.thinkingBlocks.get(index);
  if (thinking != null) {
    state.thinkingBlocks.delete(index);
    return [{ type: 'thinking-block', block: thinking }];
  }
  const draft = state.toolBlocks.get(index);
  if (draft == null) return [];
  state.toolBlocks.delete(index);
  return [toToolCallEvent(draft)];
}

function applyMessageDelta(params: { state: AnthropicStreamState; event: AnthropicEvent }): void {
  const { state, event } = params;
  const { delta, usage } = event;
  if (delta?.stop_reason != null) state.stopReason = delta.stop_reason;
  // `output_tokens` here is the running total for the whole message.
  if (usage?.output_tokens == null) return;
  state.outputTokens = usage.output_tokens;
  state.hasUsage = true;
}

function totalUsage(state: AnthropicStreamState): Usage {
  const { inputUsage: { inputTokens, cacheReadTokens, cacheCreationTokens }, outputTokens } = state;
  return { inputTokens: inputTokens + cacheReadTokens + cacheCreationTokens, outputTokens, cachedTokens: cacheReadTokens };
}

function resolveFinishReason(state: AnthropicStreamState): FinishReason {
  const { stopReason } = state;
  return stopReason == null ? 'stop' : FINISH_REASONS.get(stopReason) ?? 'stop';
}

/** Ends the turn: flushes any thinking or tool block the server never stopped (in block order), then one `usage` and `done`. */
function stopMessage(state: AnthropicStreamState): ProviderEvent[] {
  const thinking = [...state.thinkingBlocks.entries()].map(([index, block]): [number, ProviderEvent] => [index, { type: 'thinking-block', block }]);
  const tools = [...state.toolBlocks.entries()].map(([index, draft]): [number, ProviderEvent] => [index, toToolCallEvent(draft)]);
  const unstopped = [...thinking, ...tools]
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([, unstoppedEvent]) => unstoppedEvent);
  state.toolBlocks.clear();
  state.thinkingBlocks.clear();
  state.isComplete = true;
  const usageEvents: ProviderEvent[] = state.hasUsage ? [{ type: 'usage', usage: totalUsage(state) }] : [];
  return [...unstopped, ...usageEvents, { type: 'done', finishReason: resolveFinishReason(state) }];
}

function streamedError(params: { state: AnthropicStreamState; event: AnthropicEvent }): AigentError {
  const { state, event } = params;
  const errorType = event.error?.type ?? UNKNOWN_ERROR_TYPE;
  const errorMessage = event.error?.message ?? NO_ERROR_MESSAGE;
  return streamError({
    state,
    problem: `streamed an error: ${errorType}: ${errorMessage}`,
    details: { errorType, retryable: RETRYABLE_ERROR_TYPES.includes(errorType) },
  });
}

/**
 * Applies one SSE message and returns the events it completes: text and thinking deltas as they arrive, a tool call
 * when its block stops, and `usage` then `done` on `message_stop`. `ping` and unknown event types are ignored.
 */
export function applyAnthropicMessage(state: AnthropicStreamState, message: SseMessage): ProviderEvent[] {
  // Nothing after `message_stop` belongs to this turn.
  if (state.isComplete) return [];
  const event = readEvent({ state, data: message.data });
  if (event == null) return [];
  // The payload's `type` is authoritative; the SSE event name is the fallback for servers that omit it.
  const type = event.type ?? message.event;
  switch (type) {
    case 'message_start':
      rememberInputUsage({ state, event });
      return [];
    case 'content_block_start':
      startBlock({ state, event });
      return [];
    case 'content_block_delta':
      return applyDelta({ state, event });
    case 'content_block_stop':
      return stopBlock({ state, event });
    case 'message_delta':
      applyMessageDelta({ state, event });
      return [];
    case 'message_stop':
      return stopMessage(state);
    case 'error':
      throw streamedError({ state, event });
    default:
      return [];
  }
}

/** Called once the body has ended; throws `provider_failed` when `message_stop` never arrived (a cut-off stream). */
export function finishAnthropicStream(state: AnthropicStreamState): void {
  // A cut-off stream is a dropped connection that happened to close cleanly, so retrying is reasonable.
  if (!state.isComplete) throw streamError({ state, problem: 'stream ended before completion: no message_stop received', details: { retryable: true } });
}
