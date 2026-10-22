import { describe, expect, it } from 'vitest';
import { guardedFetch } from './guarded-fetch.js';
import type { HttpAccess, HttpRequest, HttpResponse } from './http-access.js';
import { createHttpPolicy } from './http-policy.js';

type Route = (request: HttpRequest) => HttpResponse;

/** A fake network: responses by URL, recording every request (and the address it would connect to). */
function fakeAccess(routes: Record<string, Route>): HttpAccess & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return {
    requests, pinsAddress: true,
    request: async request => {
      requests.push(request);
      const route = routes[request.url];
      if (route == null) throw new Error(`no route for ${request.url}`);
      return route(request);
    },
  };
}

function redirect(location: string, status = 302): Route {
  return () => ({ status, headers: { location }, body: new Uint8Array(0), truncated: false });
}

function ok(text: string): Route {
  return () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode(text), truncated: false });
}

/** DNS answers that may change between lookups (rebinding): each lookup takes the next answer, the last repeating. */
function dns(table: Record<string, string[][]>): (host: string) => Promise<string[]> {
  const counts = new Map<string, number>();
  return async host => {
    const answers = table[host];
    if (answers == null) throw new Error(`ENOTFOUND ${host}`);
    const seen = counts.get(host) ?? 0;
    counts.set(host, seen + 1);
    return answers[Math.min(seen, answers.length - 1)] as string[];
  };
}

const DNS = dns({ 'example.com': [['93.184.216.34']], 'cdn.example.com': [['93.184.216.40']], 'internal.example.com': [['10.0.0.5']], 'rebind.example.com': [['93.184.216.50'], ['127.0.0.1']] });

function fetchFrom(params: { routes: Record<string, Route>; url: string; maxRedirects?: number }) {
  const { routes, url, maxRedirects } = params;
  const access = fakeAccess(routes);
  const policy = createHttpPolicy({ allowDomains: ['example.com', '*.example.com'], resolveHost: DNS, ...(maxRedirects == null ? {} : { maxRedirects }) });
  return { access, result: guardedFetch({ policy, access, url, method: 'GET', headers: {}, signal: new AbortController().signal }) };
}

describe('guardedFetch', () => {
  it('follows allowed redirects, checking and pinning every hop', async () => {
    const { access, result } = fetchFrom({ url: 'https://example.com/a', routes: { 'https://example.com/a': redirect('https://cdn.example.com/b'), 'https://cdn.example.com/b': redirect('/c', 301), 'https://cdn.example.com/c': ok('done') } });
    expect(await result).toMatchObject({ ok: true, url: 'https://example.com/a', finalUrl: 'https://cdn.example.com/c', status: 200, redirects: 2 });
    expect(access.requests.map(({ url, pinnedAddress }) => [url, pinnedAddress])).toEqual([['https://example.com/a', '93.184.216.34'], ['https://cdn.example.com/b', '93.184.216.40'], ['https://cdn.example.com/c', '93.184.216.40']]);
  });

  it.each([
    ['the metadata endpoint', 'http://169.254.169.254/latest/meta-data/'],
    ['a decimal loopback', 'http://2130706433/'],
    ['a name that resolves privately', 'https://internal.example.com/'],
    ['a host off the allowlist', 'https://evil.net/'],
    ['another scheme', 'file:///etc/passwd'],
  ])('refuses a redirect to %s, never requesting it', async (_label, location) => {
    const { access, result } = fetchFrom({ url: 'https://example.com/a', routes: { 'https://example.com/a': redirect(location) } });
    expect(await result).toMatchObject({ ok: false, hop: 1 });
    expect(access.requests).toHaveLength(1);
  });

  it('refuses a hop whose second DNS answer is private (rebinding)', async () => {
    const { access, result } = fetchFrom({ url: 'https://rebind.example.com/a', routes: { 'https://rebind.example.com/a': redirect('https://rebind.example.com/b') } });
    expect(await result).toMatchObject({ ok: false, code: 'private_address', hop: 1, message: expect.stringContaining('127.0.0.1') });
    expect(access.requests).toHaveLength(1);
  });

  it('fetches a 303 target with GET, except after HEAD, which stays HEAD (review M2)', async () => {
    const routes = { 'https://example.com/a': redirect('https://example.com/b', 303), 'https://example.com/b': ok('done') };
    const methodsFor = async (method: 'GET' | 'HEAD') => {
      const access = fakeAccess(routes);
      const policy = createHttpPolicy({ allowDomains: ['example.com'], resolveHost: DNS });
      await guardedFetch({ policy, access, url: 'https://example.com/a', method, headers: {}, signal: new AbortController().signal });
      return access.requests.map(request => request.method);
    };
    expect(await methodsFor('HEAD')).toEqual(['HEAD', 'HEAD']);
    expect(await methodsFor('GET')).toEqual(['GET', 'GET']);
  });

  it('stops after maxRedirects', async () => {
    const loop = { 'https://example.com/a': redirect('https://example.com/b'), 'https://example.com/b': redirect('https://example.com/a') };
    const { result } = fetchFrom({ url: 'https://example.com/a', routes: loop, maxRedirects: 3 });
    expect(await result).toMatchObject({ ok: false, code: 'too_many_redirects', message: expect.stringContaining('3') });
  });

  it('refuses the first URL like any hop, and returns a redirect without a location as it is', async () => {
    expect(await fetchFrom({ url: 'http://localhost/', routes: {} }).result).toMatchObject({ ok: false, code: 'private_address', hop: 0 });
    expect(await fetchFrom({ url: 'https://example.com/a', routes: { 'https://example.com/a': () => ({ status: 302, headers: {}, body: new Uint8Array(0), truncated: false }) } }).result).toMatchObject({ ok: true, status: 302, redirects: 0 });
  });
});
