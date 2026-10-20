import { createAigentError, isAigentError } from '../core/aigent-error.js';
import type { AigentError } from '../core/aigent-error.js';
import { failedResponseError, nonStreamResponseError } from './http-error.js';
import { parseSse } from './sse-parser.js';
import type { SseMessage } from './sse-parser.js';

export interface SseRequestParams {
  providerId: string;
  fetch: typeof fetch;
  url: string;
  /** Everything but `signal`, which is always taken from `signal` below. */
  init: Omit<RequestInit, 'signal'>;
  signal: AbortSignal;
}

export interface AbortCheckParams {
  providerId: string;
  signal: AbortSignal;
}

const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream';

function abortedError(providerId: string): AigentError {
  return createAigentError({ code: 'aborted', message: `Provider '${providerId}' stream aborted` });
}

export function throwIfAborted(params: AbortCheckParams): void {
  const { providerId, signal } = params;
  if (signal.aborted) throw abortedError(providerId);
}

/** Describes a thrown value including its `cause`, since `fetch` hides the real reason (DNS, TLS, reset) there. */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { message, cause } = error;
  return cause instanceof Error && cause.message !== message ? `${message} (${cause.message})` : message;
}

interface ProviderErrorParams extends AbortCheckParams {
  error: unknown;
  /** What was happening, for the message: `request` or `stream`. */
  stage: string;
}

/** Maps anything thrown while connecting or reading: abort wins, our own errors pass through, the rest is a transport failure. */
function toProviderError(params: ProviderErrorParams): AigentError {
  const { error, providerId, signal, stage } = params;
  if (signal.aborted) return abortedError(providerId);
  if (isAigentError(error)) return error;
  return createAigentError({
    code: 'provider_failed',
    message: `Provider '${providerId}' ${stage} failed: ${describeFailure(error)}`,
    // Transport failures (DNS, resets, dropped streams) are transient by nature.
    details: { retryable: true },
  });
}

async function send(params: SseRequestParams): Promise<Response> {
  const { providerId, fetch: fetchImpl, url, init, signal } = params;
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (error) {
    throw toProviderError({ error, providerId, signal, stage: 'request' });
  }
}

interface AbortableFailureParams extends AbortCheckParams {
  /** The error being built from the response body; reading it is cut short by an abort. */
  failure: Promise<AigentError>;
}

/** An abort during the error-body read wins over the HTTP failure, as it does everywhere else. */
async function abortableFailure(params: AbortableFailureParams): Promise<AigentError> {
  const { providerId, signal, failure } = params;
  const error = await failure;
  return signal.aborted ? abortedError(providerId) : error;
}

/**
 * Re-exposes a reader as a stream we can feed to `parseSse` while keeping the reader ourselves: cancelling it ends any
 * pending read at once, even with a `fetch` that ignores the abort signal.
 */
function streamFromReader(reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: reason => reader.cancel(reason),
  });
}

/**
 * POSTs a streaming request and yields its Server-Sent Events. Non-2xx responses, transport failures and abort become
 * `provider_failed` / `aborted` AigentErrors; the response body is always cancelled when iteration ends for any reason.
 */
export async function* requestSse(params: SseRequestParams): AsyncGenerator<SseMessage> {
  const { providerId, signal } = params;
  throwIfAborted({ providerId, signal });
  const response = await send(params);
  if (!response.ok) throw await abortableFailure({ providerId, signal, failure: failedResponseError({ providerId, response, signal }) });
  // A missing content-type is tolerated (some local servers omit it); a different one means this is not a stream.
  const contentType = response.headers.get('content-type');
  if (contentType != null && !contentType.toLowerCase().includes(EVENT_STREAM_CONTENT_TYPE)) {
    throw await abortableFailure({ providerId, signal, failure: nonStreamResponseError({ providerId, response, contentType, signal }) });
  }
  const { body } = response;
  if (body == null) {
    throw createAigentError({ code: 'provider_failed', message: `Provider '${providerId}' returned HTTP ${response.status} with no body; expected an event stream` });
  }
  const reader = body.getReader();
  const cancelBody = (): void => { reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancelBody, { once: true });
  try {
    // The signal may have fired between fetch resolving and the listener being attached.
    throwIfAborted({ providerId, signal });
    for await (const message of parseSse(streamFromReader(reader))) {
      throwIfAborted({ providerId, signal });
      yield message;
    }
    // An abort cancels the reader, which ends the stream normally; report it as the abort it was.
    throwIfAborted({ providerId, signal });
  } catch (error) {
    throw toProviderError({ error, providerId, signal, stage: 'stream' });
  } finally {
    signal.removeEventListener('abort', cancelBody);
    // Cancelling an already finished or failed body is harmless; nothing useful can be done with a failure here.
    await reader.cancel().catch(() => undefined);
  }
}
