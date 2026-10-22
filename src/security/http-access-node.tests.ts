import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeHttpAccess, pinnedLookup } from './http-access-node.js';

// A loopback server only: no request in this file leaves the machine.
const GZIPPED = gzipSync('hello, compressed world');
const GZIP_BOMB = gzipSync(Buffer.alloc(10_000_000));
const server = createServer((request, response) => {
  if (request.url === '/stall') { response.writeHead(200); response.write('partial'); return; }
  // Servers that ignore `accept-encoding: identity`.
  if (request.url === '/gzip') { response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); response.end(GZIPPED); return; }
  if (request.url === '/bomb') { response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); response.end(GZIP_BOMB); return; }
  if (request.url === '/zstd') { response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'zstd' }); response.end(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])); return; }
  response.writeHead(200, { 'content-type': 'text/plain', 'x-host': request.headers.host ?? '' });
  response.end('x'.repeat(5_000));
});
let port = 0;

beforeAll(async () => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); port = (server.address() as AddressInfo).port; });
afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

describe('createNodeHttpAccess', () => {
  it('connects to the pinned address whatever the name resolves to, keeping the Host header, and caps the body', async () => {
    const access = createNodeHttpAccess();
    // `pinned.invalid` cannot resolve: the request only works because the connection goes to the pinned address.
    const response = await access.request({ url: `http://pinned.invalid:${port}/`, pinnedAddress: '127.0.0.1', method: 'GET', headers: {}, signal: new AbortController().signal, timeoutMs: 5_000, maxBodyBytes: 1_000 });
    expect(response).toMatchObject({ status: 200, truncated: true, headers: { 'x-host': `pinned.invalid:${port}` } });
    expect(response.body.byteLength).toBe(1_000);
    expect(access.pinsAddress).toBe(true);
  });

  it('times out a stalled body', async () => {
    const access = createNodeHttpAccess();
    await expect(access.request({ url: `http://pinned.invalid:${port}/stall`, pinnedAddress: '127.0.0.1', method: 'GET', headers: {}, signal: new AbortController().signal, timeoutMs: 50, maxBodyBytes: 1_000_000 })).rejects.toMatchObject({ details: { httpReason: 'timeout' } });
  });

  it('turns a request Node refuses to send (a header with a line break) into a network failure (review M4)', async () => {
    const access = createNodeHttpAccess();
    await expect(access.request({ url: `http://pinned.invalid:${port}/`, pinnedAddress: '127.0.0.1', method: 'GET', headers: { accept: 'a\r\nx-injected: 1' }, signal: new AbortController().signal, timeoutMs: 5_000, maxBodyBytes: 1_000 }))
      .rejects.toMatchObject({ details: { httpReason: 'network' } });
  });

  it('decodes a gzip body sent despite accept-encoding: identity, counting decoded bytes against the cap (review M5)', async () => {
    const access = createNodeHttpAccess();
    const get = (path: string, maxBodyBytes = 1_000_000) => access.request({ url: `http://pinned.invalid:${port}${path}`, pinnedAddress: '127.0.0.1', method: 'GET', headers: {}, signal: new AbortController().signal, timeoutMs: 5_000, maxBodyBytes });
    const decoded = await get('/gzip');
    expect(new TextDecoder().decode(decoded.body)).toBe('hello, compressed world');
    expect(decoded.headers).not.toHaveProperty('content-encoding');
    const bomb = await get('/bomb', 1_000);
    expect(bomb).toMatchObject({ truncated: true });
    expect(bomb.body.byteLength).toBe(1_000);
    // An encoding it cannot decode is returned as it came, its header kept so callers treat it as binary.
    expect((await get('/zstd')).headers).toMatchObject({ 'content-encoding': 'zstd' });
  });

  it('answers every lookup with the pinned address and its family', () => {
    const answers: unknown[] = [];
    pinnedLookup('::1')('anything', { all: true }, (_error, address) => answers.push(address));
    pinnedLookup('10.0.0.1')('anything', {}, (_error, address, family) => answers.push([address, family]));
    expect(answers).toEqual([[{ address: '::1', family: 6 }], ['10.0.0.1', 4]]);
  });
});
