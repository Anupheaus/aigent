import { createAigentError } from '../core/aigent-error.js';
import type { AigentError } from '../core/aigent-error.js';

/** One request as the web tools make it: redirects are never followed here (each hop is checked by the policy). */
export interface HttpRequest {
  /** The URL the policy allowed. */
  url: string;
  /** The address the policy checked; an access that can pin connects to it (no second DNS lookup to rebind). */
  pinnedAddress: string;
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  signal: AbortSignal;
  /** Longest the whole request may take, body included. */
  timeoutMs: number;
  /** Largest body kept; the rest is not read. */
  maxBodyBytes: number;
}

export interface HttpResponse {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string>;
  body: Uint8Array;
  truncated: boolean;
}

/** How the web tools reach the network: injected, so tests never touch it. */
export interface HttpAccess {
  request(request: HttpRequest): Promise<HttpResponse>;
  /** Whether requests connect to `pinnedAddress` (true) or resolve the host again themselves (global `fetch`). */
  pinsAddress: boolean;
}

/** Why a request failed below HTTP. */
export type HttpFailureReason = 'timeout' | 'aborted' | 'network';

/** A request failure as an access raises it: an `AigentError` with `details.httpReason`. */
export function httpError(params: { reason: HttpFailureReason; url: string; message: string }): AigentError {
  const { reason, url, message } = params;
  return createAigentError({ code: reason === 'aborted' ? 'aborted' : 'invalid_input', message: `${message} (${url})`, details: { httpReason: reason, url } });
}

/** The reason of a request failure raised by `httpError`, if it is one. */
export function httpErrorReason(error: unknown): HttpFailureReason | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const reason = (error as { details?: { httpReason?: unknown } }).details?.httpReason;
  return reason === 'timeout' || reason === 'aborted' || reason === 'network' ? reason : undefined;
}
