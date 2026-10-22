import { httpError } from './http-access.js';
import type { HttpAccess, HttpRequest, HttpResponse } from './http-access.js';
import { readLimitedBody } from './read-limited-body.js';

/** The `fetch` the access uses (global `fetch` by default; tests inject a fake). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchHttpAccessOptions {
  fetch?: FetchLike;
}

function headersOf(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
  return headers;
}

/**
 * An `HttpAccess` over global `fetch` with `redirect: 'manual'` (the caller checks every hop). It cannot
 * pin the address the policy checked (`fetch` resolves the host again), so a DNS answer that changes between the check
 * and the connection is not caught here; use an access with `pinsAddress` (`createNodeHttpAccess`) where that matters.
 * The timeout covers the whole request including the body, so a slow-loris server is cut off.
 */
export function createFetchHttpAccess(options: FetchHttpAccessOptions = {}): HttpAccess {
  const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    pinsAddress: false,
    request: async ({ url, method, headers, signal, timeoutMs, maxBodyBytes }: HttpRequest): Promise<HttpResponse> => {
      if (signal.aborted) throw httpError({ reason: 'aborted', url, message: 'The request was aborted' });
      const controller = new AbortController();
      let reason: 'timeout' | 'aborted' | undefined;
      const timer = setTimeout(() => { reason = 'timeout'; controller.abort(); }, timeoutMs);
      const onAbort = (): void => { reason = 'aborted'; controller.abort(); };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await fetchImpl(url, { method, headers, redirect: 'manual', signal: controller.signal });
        const { body, truncated } = method === 'HEAD'
          ? { body: new Uint8Array(0), truncated: false }
          : await readLimitedBody({ stream: response.body, maxBytes: maxBodyBytes, signal: controller.signal });
        if (method === 'HEAD') await response.body?.cancel().catch(() => undefined);
        return { status: response.status, headers: headersOf(response), body, truncated };
      } catch (error) {
        if (reason === 'timeout') throw httpError({ reason, url, message: `No complete response within ${timeoutMs} ms` });
        if (reason === 'aborted') throw httpError({ reason, url, message: 'The request was aborted' });
        throw httpError({ reason: 'network', url, message: `The request failed: ${error instanceof Error ? error.message : String(error)}` });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
