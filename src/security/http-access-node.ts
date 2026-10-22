import { request as httpRequest } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupAddress } from 'node:dns';
import { pipeline, Readable } from 'node:stream';
import type { Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
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

/** Decoders for the encodings a server may send although `identity` was asked for (the fetch access decodes these too). */
const DECODERS: Readonly<Record<string, () => Transform>> = { 'gzip': createGunzip, 'x-gzip': createGunzip, 'deflate': createInflate, 'br': createBrotliDecompress };

function headersOf(response: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) if (value != null) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  return headers;
}

/**
 * The response body as decoded bytes: a known `content-encoding` is decoded (and its header dropped, since the body no
 * longer has it), so the byte cap counts decoded bytes and a decompression bomb stops there. Other encodings are left
 * as they came, header kept.
 */
function decodedBody(response: IncomingMessage): { stream: ReadableStream<Uint8Array>; headers: Record<string, string> } {
  const headers = headersOf(response);
  const encoding = (headers['content-encoding'] ?? '').trim().toLowerCase();
  const createDecoder = DECODERS[encoding];
  if (createDecoder == null) return { stream: Readable.toWeb(response) as ReadableStream<Uint8Array>, headers };
  const { 'content-encoding': _encoding, ...decodedHeaders } = headers;
  // `pipeline` passes an aborted response or corrupt data on to the decoder, so the read fails instead of hanging.
  const decoder = pipeline(response, createDecoder(), () => undefined);
  return { stream: Readable.toWeb(decoder) as ReadableStream<Uint8Array>, headers: decodedHeaders };
}

/**
 * Starts the request; Node throws synchronously for some requests it refuses to send (an invalid header value), so
 * that comes back as the error instead.
 */
function startRequest(params: { request: HttpRequest; signal: AbortSignal; onResponse(response: IncomingMessage): void }): { ok: true; outgoing: ClientRequest } | { ok: false; error: unknown } {
  const { request: { url, pinnedAddress, method, headers }, signal, onResponse } = params;
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  try {
    return { ok: true, outgoing: send(target, { method, headers: { ...headers, 'accept-encoding': 'identity' }, lookup: pinnedLookup(pinnedAddress) as never, signal }, onResponse) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * An `HttpAccess` over `node:http`/`node:https` that connects to the pinned address (anti-rebinding). Bodies are
 * requested without compression (`accept-encoding: identity`) and capped like the fetch access; the timeout covers
 * the whole request.
 */
export function createNodeHttpAccess(): HttpAccess {
  return {
    pinsAddress: true,
    request: (request: HttpRequest): Promise<HttpResponse> => new Promise((resolve, reject) => {
      const { url, method, signal, timeoutMs, maxBodyBytes } = request;
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
      const onResponse = (response: IncomingMessage): void => {
        const { stream, headers } = method === 'HEAD' ? { stream: null, headers: headersOf(response) } : decodedBody(response);
        readLimitedBody({ stream, maxBytes: maxBodyBytes, signal: controller.signal }).then(({ body, truncated }) => {
          finish();
          response.destroy();
          resolve({ status: response.statusCode ?? 0, headers, body, truncated });
        }, fail);
      };
      const started = startRequest({ request, signal: controller.signal, onResponse });
      if (!started.ok) { fail(started.error); return; }
      const { outgoing } = started;
      outgoing.on('error', fail);
      outgoing.end();
    }),
  };
}
