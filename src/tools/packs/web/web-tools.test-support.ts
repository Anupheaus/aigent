// Test-only fake network for the web pack: routes by URL and a fake DNS. Excluded from the build and never exported.
import type { HttpAccess, HttpRequest, HttpResponse } from '../../../security/http-access.js';
import { createHttpPolicy } from '../../../security/http-policy.js';
import type { HttpPolicyOptions } from '../../../security/http-policy-types.js';
import type { SearchProvider } from './search-provider.js';
import { resolveWebDeps } from './web-shared.js';
import type { WebDeps } from './web-shared.js';

export type Route = (request: HttpRequest) => HttpResponse;

export function respond(params: { body?: string | Uint8Array; status?: number; headers?: Record<string, string>; truncated?: boolean }): Route {
  const { body = '', status = 200, headers = { 'content-type': 'text/plain; charset=utf-8' }, truncated = false } = params;
  return () => ({ status, headers, body: typeof body === 'string' ? new TextEncoder().encode(body) : body, truncated });
}

export function html(body: string): Route {
  return respond({ body, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export function redirectTo(location: string): Route {
  return () => ({ status: 302, headers: { location }, body: new Uint8Array(0), truncated: false });
}

/** Every host the fake DNS knows resolves publicly; `internal.example.com` resolves to a private address. */
export const FAKE_DNS: Record<string, string[]> = { 'example.com': ['93.184.216.34'], 'docs.example.com': ['93.184.216.35'], 'internal.example.com': ['10.0.0.7'] };

export interface FakeWeb {
  deps: WebDeps;
  access: HttpAccess & { requests: HttpRequest[] };
}

/** A fake network (unknown URLs answer 404) behind a policy allowing example.com and its subdomains. */
export function fakeWeb(params: { routes: Record<string, Route>; policy?: Partial<HttpPolicyOptions>; search?: SearchProvider }): FakeWeb {
  const { routes, policy = {}, search } = params;
  const requests: HttpRequest[] = [];
  const access: FakeWeb['access'] = {
    requests, pinsAddress: true,
    request: async request => {
      requests.push(request);
      const route = routes[request.url] ?? respond({ status: 404, body: 'not found' });
      const response = route(request);
      // Cut like a real access does, so the cap is exercised.
      return response.body.byteLength > request.maxBodyBytes ? { ...response, body: response.body.subarray(0, request.maxBodyBytes), truncated: true } : response;
    },
  };
  const httpPolicy = createHttpPolicy({ allowDomains: ['example.com', '*.example.com'], resolveHost: async host => { const found = FAKE_DNS[host]; if (found == null) throw new Error(`ENOTFOUND ${host}`); return found; }, ...policy });
  return { access, deps: resolveWebDeps({ policy: httpPolicy, access, ...(search == null ? {} : { search }) }) };
}
