import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import type { FinishReason, ProviderEvent, ToolCall, Usage } from './provider-types.js';

/** A tool call being assembled from `delta.tool_calls` fragments sharing one `index`. */
interface ToolCallDraft {
  id?: string;
  name?: string;
  arguments: string;
}

/** Everything remembered while reading one OpenAI-style stream; mutated by `applyOpenAiData`. */
export interface OpenAiStreamState {
  providerId: string;
  toolCalls: Map<number, ToolCallDraft>;
  /** Raw `finish_reason` as sent by the server, once one arrives. */
  finishReason?: string;
  usage?: Usage;
  hasSeenDone: boolean;
}

const DONE_DATA = '[DONE]';
/** Used when a server omits a call id, so tool results can still be matched to their call. */
const FALLBACK_CALL_ID_PREFIX = 'call_';
const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
/** Wire `finish_reason` → normalised reason; anything else (e.g. `content_filter`) is treated as `stop`. */
const FINISH_REASONS: ReadonlyMap<string, FinishReason> = new Map<string, FinishReason>([
  ['stop', 'stop'],
  ['tool_calls', 'tool_calls'],
  ['function_call', 'tool_calls'],
  ['length', 'length'],
]);

// Servers differ in which fields they send and whether absent ones are `null` or missing, so everything is nullish.
const toolCallDeltaSchema = z.object({
  index: z.number().int().nonnegative().nullish(),
  id: z.string().nullish(),
  function: z.object({ name: z.string().nullish(), arguments: z.string().nullish() }).nullish(),
});

const chunkSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({
      content: z.string().nullish(),
      reasoning_content: z.string().nullish(),
      reasoning: z.string().nullish(),
      tool_calls: z.array(toolCallDeltaSchema).nullish(),
    }).nullish(),
    finish_reason: z.string().nullish(),
  })).nullish(),
  usage: z.object({
    prompt_tokens: z.number().nullish(),
    completion_tokens: z.number().nullish(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
    prompt_cache_hit_tokens: z.number().nullish(),
  }).nullish(),
  error: z.object({ message: z.string().nullish() }).loose().nullish(),
});

type OpenAiChunk = z.infer<typeof chunkSchema>;
type ToolCallDelta = z.infer<typeof toolCallDeltaSchema>;

export function createOpenAiStreamState(providerId: string): OpenAiStreamState {
  return { providerId, toolCalls: new Map(), hasSeenDone: false };
}

function streamError(params: { state: OpenAiStreamState; problem: string }): Error {
  const { state, problem } = params;
  return createAigentError({ code: 'provider_failed', message: `Provider '${state.providerId}' ${problem}` });
}

/** Returns the parsed payload, or `undefined` for non-JSON payloads (keep-alives, comments) that are safe to skip. */
function parsePayload(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function readChunk(params: { state: OpenAiStreamState; data: string }): OpenAiChunk | undefined {
  const { state, data } = params;
  const payload = parsePayload(data);
  if (payload === undefined) return undefined;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw streamError({ state, problem: `sent a stream payload that is not a JSON object: ${data.slice(0, 200)}` });
  }
  const parsed = chunkSchema.safeParse(payload);
  if (!parsed.success) throw streamError({ state, problem: `sent an unexpected chunk shape (${parsed.error.message}): ${data.slice(0, 200)}` });
  return parsed.data;
}

function mergeToolCallDelta(params: { state: OpenAiStreamState; delta: ToolCallDelta; position: number }): void {
  const { state, delta, position } = params;
  // Some OpenAI-compatible servers omit `index`; the delta's position in the array is the best substitute.
  const index = delta.index ?? position;
  const draft = state.toolCalls.get(index) ?? { arguments: '' };
  const { id, function: fn } = delta;
  if (draft.id == null && id != null && id !== '') draft.id = id;
  if (draft.name == null && fn?.name != null && fn.name !== '') draft.name = fn.name;
  if (fn?.arguments != null) draft.arguments += fn.arguments;
  state.toolCalls.set(index, draft);
}

function rememberUsage(params: { state: OpenAiStreamState; usage: NonNullable<OpenAiChunk['usage']> }): void {
  const { state, usage } = params;
  const { prompt_tokens, completion_tokens, prompt_tokens_details, prompt_cache_hit_tokens } = usage;
  state.usage = {
    inputTokens: prompt_tokens ?? 0,
    outputTokens: completion_tokens ?? 0,
    cachedTokens: prompt_tokens_details?.cached_tokens ?? prompt_cache_hit_tokens ?? 0,
  };
}

/**
 * Applies one SSE `data` payload. Returns the text and thinking events it carries; tool calls, usage and `done` are
 * held until `finishOpenAiStream` because their fragments can arrive in any later chunk.
 */
export function applyOpenAiData(state: OpenAiStreamState, data: string): ProviderEvent[] {
  if (data.trim() === DONE_DATA) {
    state.hasSeenDone = true;
    return [];
  }
  const chunk = readChunk({ state, data });
  if (chunk == null) return [];
  const { choices, usage, error } = chunk;
  if (error != null) throw streamError({ state, problem: `streamed an error: ${error.message ?? JSON.stringify(error)}` });
  if (usage != null) rememberUsage({ state, usage });
  const choice = choices?.[0];
  if (choice == null) return [];
  const { delta, finish_reason } = choice;
  if (finish_reason != null) state.finishReason = finish_reason;
  const events: ProviderEvent[] = [];
  const thinking = delta?.reasoning_content ?? delta?.reasoning;
  if (thinking != null && thinking !== '') events.push({ type: 'thinking-delta', text: thinking });
  if (delta?.content != null && delta.content !== '') events.push({ type: 'text-delta', text: delta.content });
  delta?.tool_calls?.forEach((toolCallDelta, position) => mergeToolCallDelta({ state, delta: toolCallDelta, position }));
  return events;
}

/** Malformed JSON stays a raw string so tool argument validation can report a precise, retryable error. */
function parseArguments(raw: string): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toToolCall(params: { index: number; draft: ToolCallDraft }): ToolCall {
  const { index, draft } = params;
  const { id = `${FALLBACK_CALL_ID_PREFIX}${index}`, name = '', arguments: raw } = draft;
  return { id, name, args: parseArguments(raw) };
}

function resolveFinishReason(state: OpenAiStreamState): FinishReason {
  const { finishReason, toolCalls } = state;
  if (finishReason == null) return toolCalls.size > 0 ? 'tool_calls' : 'stop';
  return FINISH_REASONS.get(finishReason) ?? 'stop';
}

/**
 * Called once the body has ended: emits the assembled tool calls in index order, one `usage` (zeros if the server sent
 * none) and `done`. Throws `provider_failed` when neither a `finish_reason` nor `[DONE]` arrived (a cut-off stream).
 */
export function finishOpenAiStream(state: OpenAiStreamState): ProviderEvent[] {
  const { finishReason, hasSeenDone, toolCalls, usage = ZERO_USAGE } = state;
  if (finishReason == null && !hasSeenDone) throw streamError({ state, problem: 'stream ended before completion: no finish_reason or [DONE] received' });
  const calls: ProviderEvent[] = [...toolCalls.entries()]
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([index, draft]) => ({ type: 'tool-call', call: toToolCall({ index, draft }) }));
  return [...calls, { type: 'usage', usage }, { type: 'done', finishReason: resolveFinishReason(state) }];
}
