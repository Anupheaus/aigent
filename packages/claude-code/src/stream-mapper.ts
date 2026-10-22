import { createAigentError } from '@anupheaus/aigent';
import type { FinishReason, ProviderEvent, Usage } from '@anupheaus/aigent';
import type { SdkMessage } from './sdk-boundary.js';

/** Anthropic's stop reason for an answer cut off by the output token limit. */
const MAX_TOKENS_STOP = 'max_tokens';
const SUCCESS = 'success';
/** The SDK's own turn limit: the answer is incomplete, like a token cut-off. */
const MAX_TURNS = 'error_max_turns';

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** `modelUsage` (per model, camelCase) summed when present, else the result's `usage`; input counts cached reads and writes. */
export function usageOf(result: Fields): Usage | undefined {
  const { modelUsage, usage } = result;
  if (isFields(modelUsage) && Object.keys(modelUsage).length > 0) {
    const models = Object.values(modelUsage).filter(isFields);
    const sum = (field: string): number => models.reduce((total, model) => total + count(model[field]), 0);
    const cachedTokens = sum('cacheReadInputTokens');
    return { inputTokens: sum('inputTokens') + cachedTokens + sum('cacheCreationInputTokens'), outputTokens: sum('outputTokens'), cachedTokens };
  }
  if (!isFields(usage)) return undefined;
  const cachedTokens = count(usage.cache_read_input_tokens);
  return { inputTokens: count(usage.input_tokens) + cachedTokens + count(usage.cache_creation_input_tokens), outputTokens: count(usage.output_tokens), cachedTokens };
}

interface MapperState {
  /** The current assistant message streamed text through partial events, so its full copy must not repeat it. */
  isStreamed: boolean;
  stopReason?: string;
}

/** Events for one SDK message; `done` and errors come from `finish`. Tool calls are bridged, so tool_use is never emitted. */
function eventsOf(message: SdkMessage, state: MapperState): ProviderEvent[] {
  if (message.type === 'stream_event' && isFields(message.event)) {
    const { event } = message;
    if (event.type === 'message_start') state.isStreamed = false;
    if (event.type === 'message_delta' && isFields(event.delta) && typeof event.delta.stop_reason === 'string') state.stopReason = event.delta.stop_reason;
    if (event.type !== 'content_block_delta' || !isFields(event.delta)) return [];
    const { delta } = event;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') { state.isStreamed = true; return [{ type: 'text-delta', text: delta.text }]; }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') { state.isStreamed = true; return [{ type: 'thinking-delta', text: delta.thinking }]; }
    return [];
  }
  if (message.type === 'assistant' && isFields(message.message)) {
    const { content, stop_reason: stopReason } = message.message;
    if (typeof stopReason === 'string') state.stopReason = stopReason;
    const wasStreamed = state.isStreamed;
    state.isStreamed = false;
    if (wasStreamed || !Array.isArray(content)) return [];
    return content.filter(isFields).flatMap((block): ProviderEvent[] => {
      if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text-delta', text: block.text }];
      if (block.type === 'thinking' && typeof block.thinking === 'string') return [{ type: 'thinking-delta', text: block.thinking }];
      return [];
    });
  }
  return [];
}

/** The terminal events of a `result` message, or the failure it reports. */
function finish(params: { result: SdkMessage; state: MapperState; label: string }): ProviderEvent[] {
  const { result, state, label } = params;
  const { subtype } = result;
  if (subtype !== SUCCESS && subtype !== MAX_TURNS) {
    const errors = Array.isArray(result.errors) ? result.errors.filter(entry => typeof entry === 'string').join('; ') : '';
    const text = errors || (typeof result.result === 'string' ? result.result : '') || 'no detail';
    throw createAigentError({ code: 'provider_failed', message: `${label} run failed (${String(subtype)}): ${text}`, details: { subtype, retryable: false } });
  }
  const usage = usageOf(result);
  const finishReason: FinishReason = subtype === MAX_TURNS || state.stopReason === MAX_TOKENS_STOP ? 'length' : 'stop';
  return [...(usage == null ? [] : [{ type: 'usage', usage } as const]), { type: 'done', finishReason }];
}

function abortedError(label: string): Error {
  return createAigentError({ code: 'aborted', message: `${label} stream was aborted` });
}

/** Resolves when `signal` aborts; the listener is removed by `dispose`. */
function abortWaiter(signal: AbortSignal): { aborted: Promise<'aborted'>; dispose(): void } {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<'aborted'>(resolve => { onAbort = () => resolve('aborted'); signal.addEventListener('abort', onAbort, { once: true }); });
  return { aborted, dispose: () => { if (onAbort != null) signal.removeEventListener('abort', onAbort); } };
}

/**
 * Maps the SDK stream to provider events: text and thinking deltas (partial messages, or a whole assistant message
 * that was not streamed), one usage event, then `done`. Rejects `aborted` promptly on abort (closing the stream), and
 * `provider_failed` (retryable) when the stream breaks or ends without a result.
 */
export async function* mapSdkStream(params: { messages: AsyncIterable<SdkMessage>; signal: AbortSignal; label: string }): AsyncGenerator<ProviderEvent> {
  const { messages, signal, label } = params;
  if (signal.aborted) throw abortedError(label);
  const iterator = messages[Symbol.asyncIterator]();
  const waiter = abortWaiter(signal);
  const state: MapperState = { isStreamed: false };
  let isFinished = false;
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), waiter.aborted]).catch((error: unknown) => {
        if (signal.aborted) throw abortedError(label);
        throw createAigentError({ code: 'provider_failed', message: `${label} stream failed: ${error instanceof Error ? error.message : String(error)}`, details: { retryable: true } });
      });
      if (next === 'aborted') throw abortedError(label);
      if (next.done === true) { isFinished = true; break; }
      if (next.value.type === 'result') {
        yield* finish({ result: next.value, state, label });
        return;
      }
      yield* eventsOf(next.value, state);
    }
  } finally {
    waiter.dispose();
    // Stopping early (abort, a consumer that stopped iterating, a result) ends the SDK run and its subprocess.
    if (!isFinished) void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
  throw createAigentError({ code: 'provider_failed', message: `${label} stream ended without a result`, details: { retryable: true } });
}
