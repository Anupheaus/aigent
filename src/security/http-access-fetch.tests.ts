import { describe, expect, it } from 'vitest';
import { createFetchHttpAccess } from './http-access-fetch.js';
import type { HttpRequest } from './http-access.js';

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { url: 'https://example.com/a', pinnedAddress: '93.184.216.34', method: 'GET', headers: { accept: 'text/html' }, signal: new AbortController().signal, timeoutMs: 1_000, maxBodyBytes: 100, ...overrides };
}

/** A body that sends one chunk, then never another (a slow-loris server). */
function stalled(): { body: ReadableStream<Uint8Array>; cancelled(): boolean } {
  let cancelled = false;
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull: controller => { if (!sent) { sent = true; controller.enqueue(new Uint8Array([104, 105])); } return new Promise(() => undefined); },
    cancel: () => { cancelled = true; },
  });
  return { body, cancelled: () => cancelled };
}

describe('createFetchHttpAccess', () => {
  it('never follows redirects itself, lower-cases header names and caps the body', async () => {
    const seen: RequestInit[] = [];
    const access = createFetchHttpAccess({
      fetch: async (_url, init) => { seen.push(init ?? {}); return new Response('x'.repeat(500), { status: 200, headers: { 'Content-Type': 'text/plain', 'X-Thing': '1' } }); },
    });
    const response = await access.request(request());
    expect(seen[0]).toMatchObject({ method: 'GET', redirect: 'manual', headers: { accept: 'text/html' } });
    expect(response).toMatchObject({ status: 200, truncated: true, headers: { 'content-type': 'text/plain', 'x-thing': '1' } });
    expect(response.body.byteLength).toBe(100);
    expect(access.pinsAddress).toBe(false);
  });

  it('reads no body for HEAD', async () => {
    const access = createFetchHttpAccess({ fetch: async () => new Response('ignored', { status: 200 }) });
    expect((await access.request(request({ method: 'HEAD' }))).body.byteLength).toBe(0);
  });

  it('times out a response whose body stalls (slow loris), cancelling it', async () => {
    const source = stalled();
    const access = createFetchHttpAccess({ fetch: async () => new Response(source.body, { status: 200 }) });
    await expect(access.request(request({ timeoutMs: 30, maxBodyBytes: 1_000_000 }))).rejects.toMatchObject({ details: { httpReason: 'timeout' } });
    expect(source.cancelled()).toBe(true);
  });

  it('times out a server that never answers, and turns network errors and aborts into reasons', async () => {
    const hanging = createFetchHttpAccess({ fetch: (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); }) });
    await expect(hanging.request(request({ timeoutMs: 20 }))).rejects.toMatchObject({ details: { httpReason: 'timeout' } });
    const failing = createFetchHttpAccess({ fetch: async () => { throw new TypeError('fetch failed'); } });
    await expect(failing.request(request())).rejects.toMatchObject({ details: { httpReason: 'network' }, message: expect.stringContaining('fetch failed') });
    const controller = new AbortController();
    controller.abort();
    await expect(hanging.request(request({ signal: controller.signal }))).rejects.toMatchObject({ details: { httpReason: 'aborted' } });
  });
});
