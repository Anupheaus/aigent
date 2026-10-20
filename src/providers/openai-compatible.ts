import { OPENAI_RESERVED_BODY_FIELDS, toOpenAiChatRequest } from './openai-messages.js';
import { reservedOptionWarnings } from './provider-options.js';
import { createOpenAiUnsupportedSettings, OPENAI_SUPPORTED_SETTINGS } from './openai-settings.js';
import type { OpenAiTokenLimitField, ReasoningModelMatcher } from './openai-settings.js';
import { applyOpenAiData, createOpenAiStreamState, finishOpenAiStream } from './openai-stream.js';
import type { Provider, ProviderCapabilities, ProviderEvent, ProviderRequest } from './provider-types.js';
import { collectSecrets, redactingErrors } from './secret-redaction.js';
import { requestSse, throwIfAborted } from './sse-request.js';

export interface OpenAiCompatibleOptions {
  /** Provider id, the prefix in `provider:model` strings. */
  id: string;
  /** API root without the endpoint, e.g. `https://api.openai.com/v1`; requests go to `${baseUrl}/chat/completions`. */
  baseUrl: string;
  /** Sent as `authorization: Bearer <apiKey>` when set; never included in errors. */
  apiKey?: string;
  /** Extra request headers (e.g. organisation or project ids). */
  headers?: Record<string, string>;
  /** HTTP implementation; defaults to the global `fetch`. Inject one for tests or proxies. */
  fetch?: typeof fetch;
  /** Published context window in tokens (default 128_000). */
  maxContextTokens?: number;
  /** Whether the backend can return several tool calls in one turn (default true). */
  supportsParallelToolCalls?: boolean;
  /** Body field for `maxOutputTokens` (default `max_tokens`; OpenAI's own API wants `max_completion_tokens`). */
  tokenLimitField?: OpenAiTokenLimitField;
  /**
   * Which models are reasoning models: they get `reasoning_effort` and have `temperature`, `topP` and `stop` dropped
   * with a warning; other models have `effort` dropped. Without it, a request that sends `reasoning_effort` is treated
   * as a reasoning model.
   */
  isReasoningModel?: ReasoningModelMatcher;
}

const CHAT_COMPLETIONS_PATH = '/chat/completions';
const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;
const DEFAULT_TOKEN_LIMIT_FIELD: OpenAiTokenLimitField = 'max_tokens';
const TRAILING_SLASHES = /\/+$/;

function buildHeaders(options: OpenAiCompatibleOptions): Record<string, string> {
  const { apiKey, headers } = options;
  return {
    'content-type': 'application/json',
    ...(apiKey == null ? {} : { authorization: `Bearer ${apiKey}` }),
    ...headers,
  };
}

/** A provider for any server speaking the OpenAI streaming Chat Completions API (OpenAI, DeepSeek, Ollama, vLLM, ...). */
export function openAiCompatible(options: OpenAiCompatibleOptions): Provider {
  const { id, baseUrl, fetch: fetchImpl = fetch, maxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS, supportsParallelToolCalls = true, tokenLimitField = DEFAULT_TOKEN_LIMIT_FIELD, isReasoningModel } = options;
  const url = `${baseUrl.replace(TRAILING_SLASHES, '')}${CHAT_COMPLETIONS_PATH}`;
  const capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    parallelToolCalls: supportsParallelToolCalls,
    promptCaching: false,
    vision: false,
    maxContextTokens,
    supportedSettings: [...OPENAI_SUPPORTED_SETTINGS],
  };

  const headers = buildHeaders(options);
  const secrets = collectSecrets(headers);

  async function* streamEvents(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const state = createOpenAiStreamState(id);
    const init = { method: 'POST', headers, body: JSON.stringify(toOpenAiChatRequest(request, { tokenLimitField })) };
    // One chunk can carry several events; re-check the signal before each so nothing is yielded after an abort.
    const emit = function* (events: ProviderEvent[]): Generator<ProviderEvent> {
      for (const event of events) {
        throwIfAborted({ providerId: id, signal });
        yield event;
      }
    };
    for await (const { data } of requestSse({ providerId: id, fetch: fetchImpl, url, init, signal })) {
      yield* emit(applyOpenAiData(state, data));
    }
    yield* emit(finishOpenAiStream(state));
  }

  const stream = (request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> => (
    redactingErrors({ events: streamEvents(request, signal), secrets })
  );

  return {
    id, capabilities, stream,
    unsupportedSettings: createOpenAiUnsupportedSettings(isReasoningModel),
    settingsWarnings: ({ providerOptions }) => reservedOptionWarnings({ providerId: id, providerOptions, reserved: OPENAI_RESERVED_BODY_FIELDS }),
  };
}
