import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupAddress } from 'node:dns';
import { Readable } from 'node:stream';
import { httpError } from './http-access.js';
import type { HttpAccess, HttpRequest, HttpResponse } from './http-access.js';
import { readLimitedBody } from './read-limited-body.js';

const IPV6_FAMILY = 6;
const IPV4_FAMILY = 4;

/** The callback `net` hands a `lookup` function: one address, or all of them when asked with `{ all: true }`. */
type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` that answers every name with the address the policy checked, so the connection goes exactly there: a
 * DNS answer that changes after the check (rebinding) is never used. TLS still verifies the certificate for the host
 * name in the URL.
 */
export function pinnedLookup(address: string): (hostname: string, options: { all?: boolean }, callback: LookupCallback) => void {
  const family = address.includes(':') ? IPV6_FAMILY : IPV4_FAMILY;
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function headersOf(response: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) if (value != null) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  return headers;
}

/**
 * An `HttpAccess` over `node:http`/`node:https` that connects to the pinned address (anti-rebinding). Bodies are
 * requested without compression (`accept-encoding: identity`) and capped like the fetch access; the timeout covers
 * the whole request.
 */
export function createNodeHttpAccess(): HttpAccess {
  return {
    pinsAddress: true,
    request: ({ url, pinnedAddress, method, headers, signal, timeoutMs, maxBodyBytes }: HttpRequest): Promise<HttpResponse> => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(httpError({ reason: 'aborted', url, message: 'The request was aborted' })); return; }
      const controller = new AbortController();
      let reason: 'timeout' | 'aborted' | undefined;
      const timer = setTimeout(() => { reason = 'timeout'; controller.abort(); }, timeoutMs);
      const onAbort = (): void => { reason = 'aborted'; controller.abort(); };
      signal.addEventListener('abort', onAbort, { once: true });
      const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
      const fail = (error: unknown): void => {
        finish();
        if (reason === 'timeout') reject(httpError({ reason, url, message: `No complete response within ${timeoutMs} ms` }));
        else if (reason === 'aborted') reject(httpError({ reason, url, message: 'The request was aborted' }));
        else reject(httpError({ reason: 'network', url, message: `The request failed: ${error instanceof Error ? error.message : String(error)}` }));
      };
      const target = new URL(url);
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const outgoing = send(target, { method, headers: { ...headers, 'accept-encoding': 'identity' }, lookup: pinnedLookup(pinnedAddress) as never, signal: controller.signal }, response => {
        const stream = method === 'HEAD' ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
        readLimitedBody({ stream, maxBytes: maxBodyBytes, signal: controller.signal }).then(({ body, truncated }) => {
          finish();
          response.destroy();
          resolve({ status: response.statusCode ?? 0, headers: headersOf(response), body, truncated });
        }, fail);
      });
      outgoing.on('error', fail);
      outgoing.end();
    }),
  };
}
