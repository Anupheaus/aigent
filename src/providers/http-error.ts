import { createAigentError } from '../core/aigent-error.js';
import type { AigentError } from '../core/aigent-error.js';

export interface FailedResponseParams {
  /** Provider id, named in the message so the failing backend is obvious. */
  providerId: string;
  response: Response;
}

/** Longest slice of an error body kept in `details.body`; bodies can be large HTML pages. */
const MAX_ERROR_BODY_CHARS = 2000;
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

/**
 * Builds the `provider_failed` error for a non-2xx response: `details` carries `status`, `retryable` and the start of
 * the body. The message names the provider and status only, so it can never contain request credentials.
 */
export async function failedResponseError(params: FailedResponseParams): Promise<AigentError> {
  const { providerId, response } = params;
  const { status, statusText } = response;
  const body = await readBodyPrefix(response);
  const reason = statusText === '' ? '' : ` ${statusText}`;
  return createAigentError({
    code: 'provider_failed',
    message: `Provider '${providerId}' request failed with HTTP ${status}${reason}; expected a 2xx response`,
    details: { status, retryable: isRetryableStatus(status), body },
  });
}
