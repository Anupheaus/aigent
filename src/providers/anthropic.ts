import { toAnthropicMessagesRequest } from './anthropic-messages.js';
import { ANTHROPIC_SUPPORTED_SETTINGS, anthropicSettingsWarnings, anthropicUnsupportedSettings } from './anthropic-settings.js';
import { applyAnthropicMessage, createAnthropicStreamState, finishAnthropicStream } from './anthropic-stream.js';
import type { Provider, ProviderCapabilities, ProviderEvent, ProviderRequest } from './provider-types.js';
import { collectSecrets, redactingErrors } from './secret-redaction.js';
import { requestSse, throwIfAborted } from './sse-request.js';

export interface AnthropicOptions {
  /** Sent as the `x-api-key` header; never included in errors. */
  apiKey: string;
  /** API root without the endpoint (default `https://api.anthropic.com`); requests go to `${baseUrl}/v1/messages`. */
  baseUrl?: string;
  /** HTTP implementation; defaults to the global `fetch`. Inject one for tests or proxies. */
  fetch?: typeof fetch;
  /** `max_tokens` when a request sets no `maxOutputTokens` setting (default 4096); the API requires one. */
  defaultMaxTokens?: number;
  /** Marks the system prompt as an ephemeral cache breakpoint (default true); a request's `promptCaching` setting overrides it. */
  promptCaching?: boolean;
  /** Published context window in tokens (default 200_000). */
  maxContextTokens?: number;
  /** `anthropic-version` header (default `2023-06-01`). */
  version?: string;
}

const PROVIDER_ID = 'anthropic';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const MESSAGES_PATH = '/v1/messages';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
const DEFAULT_API_VERSION = '2023-06-01';
const TRAILING_SLASHES = /\/+$/;

/** A provider for Claude models over the streaming Anthropic Messages API. */
export function anthropic(options: AnthropicOptions): Provider {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    fetch: fetchImpl = fetch,
    defaultMaxTokens = DEFAULT_MAX_TOKENS,
    promptCaching = true,
    maxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS,
    version = DEFAULT_API_VERSION,
  } = options;
  const url = `${baseUrl.replace(TRAILING_SLASHES, '')}${MESSAGES_PATH}`;
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': version };
  const capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    parallelToolCalls: true,
    promptCaching,
    vision: false,
    maxContextTokens,
    thinkingBlocks: true,
    supportedSettings: [...ANTHROPIC_SUPPORTED_SETTINGS],
  };

  const secrets = collectSecrets(headers);

  async function* streamEvents(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const state = createAnthropicStreamState(PROVIDER_ID);
    const body = JSON.stringify(toAnthropicMessagesRequest(request, { defaultMaxTokens, promptCaching }));
    const init = { method: 'POST', headers, body };
    for await (const message of requestSse({ providerId: PROVIDER_ID, fetch: fetchImpl, url, init, signal })) {
      // `message_stop` yields usage and done together; re-check the signal before each so nothing follows an abort.
      for (const event of applyAnthropicMessage(state, message)) {
        throwIfAborted({ providerId: PROVIDER_ID, signal });
        yield event;
      }
    }
    finishAnthropicStream(state);
  }

  const stream = (request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> => (
    redactingErrors({ events: streamEvents(request, signal), secrets })
  );

  return { id: PROVIDER_ID, capabilities, stream, unsupportedSettings: anthropicUnsupportedSettings, settingsWarnings: anthropicSettingsWarnings };
}
