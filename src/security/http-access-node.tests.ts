import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeHttpAccess, pinnedLookup } from './http-access-node.js';

// A loopback server only: no request in this file leaves the machine.
const server = createServer((request, response) => {
  if (request.url === '/stall') { response.writeHead(200); response.write('partial'); return; }
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

  it('answers every lookup with the pinned address and its family', () => {
    const answers: unknown[] = [];
    pinnedLookup('::1')('anything', { all: true }, (_error, address) => answers.push(address));
    pinnedLookup('10.0.0.1')('anything', {}, (_error, address, family) => answers.push([address, family]));
    expect(answers).toEqual([[{ address: '::1', family: 6 }], ['10.0.0.1', 4]]);
  });
});
