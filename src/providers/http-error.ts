import { createAigentError } from '../core/aigent-error.js';
import type { AigentError } from '../core/aigent-error.js';

export interface FailedResponseParams {
  /** Provider id, named in the message so the failing backend is obvious. */
  providerId: string;
  response: Response;
}

/** Longest slice of an error body kept in `details.body`; bodies can be large HTML pages. */
const MAX_ERROR_BODY_CHARS = 2000;
/** Longest server reason quoted in the error message; the full body stays in `details.body`. */
const MAX_REASON_CHARS = 300;
/** Timeout, conflict and rate-limit statuses that are worth retrying, besides every 5xx. */
const RETRYABLE_STATUSES: readonly number[] = [408, 409, 429];
const FIRST_SERVER_ERROR_STATUS = 500;

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.includes(status) || status >= FIRST_SERVER_ERROR_STATUS;
}

/** Reads at most `MAX_ERROR_BODY_CHARS` characters, then cancels the rest so a huge or endless body cannot stall us. */
async function readBodyPrefix(response: Response): Promise<string> {
  const { body } = response;
  if (body == null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  try {
    while (text.length < MAX_ERROR_BODY_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    // The body is diagnostic only; a failed read still leaves the status to report.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, MAX_ERROR_BODY_CHARS);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON (an HTML error page, plain text, or a body cut at MAX_ERROR_BODY_CHARS): there is no reason to extract.
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(params: { value: unknown; key: string }): string | undefined {
  const { value, key } = params;
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' && field.trim() !== '' ? field : undefined;
}

/**
 * The server's own explanation from a JSON error body: `error.message` (OpenAI, Anthropic), a string `error`, or a
 * top-level `message`. It is what tells a user "model not found" or "invalid key", so it belongs in the message.
 */
function serverReason(body: string): string | undefined {
  const parsed = parseJson(body);
  const error = isRecord(parsed) ? parsed.error : undefined;
  const reason = stringField({ value: error, key: 'message' }) ?? (typeof error === 'string' ? error : undefined) ?? stringField({ value: parsed, key: 'message' });
  return reason?.slice(0, MAX_REASON_CHARS);
}

function withReason(params: { message: string; body: string }): string {
  const { message, body } = params;
  const reason = serverReason(body);
  return reason == null ? message : `${message}: ${reason}`;
}

export interface NonStreamResponseParams extends FailedResponseParams {
  /** The `content-type` the server sent instead of `text/event-stream`. */
  contentType: string;
}

/**
 * Builds the `provider_failed` error for a 2xx response that is not an event stream (e.g. a proxy answering JSON, or a
 * server ignoring `stream: true`). Not retryable: the same request would get the same answer.
 */
export async function nonStreamResponseError(params: NonStreamResponseParams): Promise<AigentError> {
  const { providerId, response, contentType } = params;
  const { status } = response;
  const body = await readBodyPrefix(response);
  const message = `Provider '${providerId}' returned HTTP ${status} with content-type ${contentType}; expected text/event-stream`;
  return createAigentError({ code: 'provider_failed', message: withReason({ message, body }), details: { status, retryable: false, body } });
}

/**
 * Builds the `provider_failed` error for a non-2xx response: `details` carries `status`, `retryable` and the start of
 * the body, and the message adds the server's reason when the body has one. Adapters redact credentials from both
 * (see `redactingErrors`), since servers sometimes echo the key.
 */
export async function failedResponseError(params: FailedResponseParams): Promise<AigentError> {
  const { providerId, response } = params;
  const { status, statusText } = response;
  const body = await readBodyPrefix(response);
  const statusReason = statusText === '' ? '' : ` ${statusText}`;
  const message = `Provider '${providerId}' request failed with HTTP ${status}${statusReason}; expected a 2xx response`;
  return createAigentError({
    code: 'provider_failed',
    message: withReason({ message, body }),
    details: { status, retryable: isRetryableStatus(status), body },
  });
}
