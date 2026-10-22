import type { HttpAccess, HttpResponse } from './http-access.js';
import type { HttpDenialCode, HttpPolicy } from './http-policy-types.js';

/** Statuses whose `location` is followed. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** "See Other": the target is fetched with GET. */
const SEE_OTHER = 303;

export interface GuardedFetchParams {
  policy: HttpPolicy;
  access: HttpAccess;
  url: string;
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  signal: AbortSignal;
}

/** A response reached through allowed hops only, or the hop that was refused (`hop` 0 is the first URL). */
export type GuardedFetchResult =
  | (HttpResponse & { ok: true; url: string; finalUrl: string; redirects: number })
  | { ok: false; code: HttpDenialCode | 'too_many_redirects'; message: string; suggestion?: string; hop: number; url: string };

/**
 * Fetches `url`, following redirects itself: every hop (the first URL included) goes through `policy.checkUrl`
 * (allowlist, DNS, every address public) before it is requested, and is requested at the address that check pinned.
 */
export async function guardedFetch(params: GuardedFetchParams): Promise<GuardedFetchResult> {
  const { policy, access, url, headers, signal } = params;
  const { maxRedirects, maxBodyBytes, timeoutMs } = policy.limits;
  let method = params.method;
  let current = url;
  let first: string | undefined;
  for (let hop = 0; ; hop += 1) {
    const decision = await policy.checkUrl(current);
    if (!decision.allowed) {
      const { code, message, suggestion } = decision;
      return { ok: false, code, message: hop === 0 ? message : `Redirect ${hop} refused: ${message}`, hop, url: current, ...(suggestion == null ? {} : { suggestion }) };
    }
    first ??= decision.url;
    const response = await access.request({ url: decision.url, pinnedAddress: decision.pinnedAddress, method, headers, signal, timeoutMs, maxBodyBytes });
    const { location } = response.headers;
    if (!REDIRECT_STATUSES.has(response.status) || location == null) return { ok: true, ...response, url: first, finalUrl: decision.url, redirects: hop };
    if (hop >= maxRedirects) return { ok: false, code: 'too_many_redirects', message: `Stopped after ${maxRedirects} redirects (the next was to '${location}')`, hop, url: decision.url };
    try {
      current = new URL(location, decision.url).href;
    } catch {
      return { ok: false, code: 'invalid_url', message: `Redirect ${hop + 1} refused: its location '${location}' is not a URL`, hop: hop + 1, url: location };
    }
    // A 303 answer is fetched with GET, except that HEAD stays HEAD (as the Fetch standard says): no body is wanted.
    if (response.status === SEE_OTHER && method !== 'HEAD') method = 'GET';
  }
}
