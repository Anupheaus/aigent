import { LIBRARY_VERSION } from '../../../core/library-version.js';
import { guardedFetch } from '../../../security/guarded-fetch.js';
import type { GuardedFetchResult } from '../../../security/guarded-fetch.js';
import { httpErrorReason } from '../../../security/http-access.js';
import type { HttpAccess } from '../../../security/http-access.js';
import { createFetchHttpAccess } from '../../../security/http-access-fetch.js';
import type { HttpPolicy } from '../../../security/http-policy-types.js';
import { toolFailure } from '../../tool-failure.js';
import type { SearchProvider } from './search-provider.js';

/** `webTools(options)`. */
export interface WebToolsOptions {
  /** The URL authority every request (and every redirect) goes through; deny by default. */
  policy: HttpPolicy;
  /** Default: global `fetch` (`createFetchHttpAccess()`); `createNodeHttpAccess()` also pins the checked address. */
  access?: HttpAccess;
  /** Registers `web_search`; without one the tool is not offered. */
  search?: SearchProvider;
  /** Default `aigent/<version>`. */
  userAgent?: string;
}

/** What every web tool is built from. */
export interface WebDeps {
  policy: HttpPolicy;
  access: HttpAccess;
  search?: SearchProvider;
  userAgent: string;
}

export function resolveWebDeps(options: WebToolsOptions): WebDeps {
  const { policy, access = createFetchHttpAccess(), search, userAgent = `aigent/${LIBRARY_VERSION}` } = options;
  return { policy, access, userAgent, ...(search == null ? {} : { search }) };
}

/** Fetched pages change; cached results are kept five minutes. */
export const WEB_CACHE_TTL_MS = 300_000;
/** Upper bound on items in one `http_fetch` or `page_extract` call. */
export const MAX_FETCH_ITEMS = 10;
/** Longest error-body excerpt kept on an HTTP error. */
const ERROR_EXCERPT_CHARS = 500;
const FIRST_ERROR_STATUS = 400;
const SERVER_ERROR_STATUS = 500;
const TOO_MANY_REQUESTS = 429;

export type FetchedPage = Extract<GuardedFetchResult, { ok: true }>;

/** Fetches through the policy; a refused hop or a failed request becomes an item failure the model can act on. */
export async function fetchChecked(params: { deps: WebDeps; url: string; method: 'GET' | 'HEAD'; headers: Record<string, string>; signal: AbortSignal }): Promise<FetchedPage> {
  const { deps: { policy, access, userAgent }, url, method, headers, signal } = params;
  let result: GuardedFetchResult;
  try {
    result = await guardedFetch({ policy, access, url, method, headers: { 'user-agent': userAgent, ...headers }, signal });
  } catch (error) {
    const reason = httpErrorReason(error) ?? 'network';
    throw toolFailure({ code: reason === 'network' ? 'network_error' : reason, message: error instanceof Error ? error.message : String(error), retryable: reason !== 'aborted', details: { url } });
  }
  if (!result.ok) {
    const { code, message, suggestion, hop, url: refused } = result;
    // A name that did not resolve may resolve on a retry; every other refusal is final.
    throw toolFailure({ category: 'denied', code, message, retryable: code === 'dns_failed', details: { url, hop, refused }, ...(suggestion == null ? {} : { suggestion }) });
  }
  return result;
}

/** The charset of a `content-type` header (default utf-8). */
export function charsetOf(contentType: string): string {
  return /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8';
}

/** The body as text in its declared charset (unknown charsets fall back to utf-8; bad bytes become U+FFFD). */
export function decodeBody(params: { body: Uint8Array; contentType: string }): string {
  const { body, contentType } = params;
  try {
    return new TextDecoder(charsetOf(contentType)).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

const TEXTUAL_TYPE = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|javascript|ecmascript|x-www-form-urlencoded|ld\+json|rss\+xml|atom\+xml|[\w.+-]*\+(?:json|xml))|image\/svg\+xml)/i;
/** Bytes sniffed for NUL when a response has no content type. */
const SNIFF_BYTES = 1_024;

/** Whether a body is text to show (by content type, or by sniffing for NUL bytes when there is none). */
export function isTextual(params: { body: Uint8Array; contentType: string }): boolean {
  const { body, contentType } = params;
  if (contentType !== '') return TEXTUAL_TYPE.test(contentType.trim());
  return !body.subarray(0, SNIFF_BYTES).includes(0);
}

export function isHtml(contentType: string): boolean {
  return /^(?:text\/html|application\/xhtml\+xml)/i.test(contentType.trim());
}

/** An error status as an item failure (with a short excerpt of the body); 5xx and 429 may be retried. */
export function assertSuccess(page: FetchedPage): void {
  const { status, finalUrl, body, headers } = page;
  if (status < FIRST_ERROR_STATUS) return;
  const excerpt = decodeBody({ body: body.subarray(0, ERROR_EXCERPT_CHARS * 4), contentType: headers['content-type'] ?? '' }).slice(0, ERROR_EXCERPT_CHARS);
  throw toolFailure({
    code: 'http_error', message: `HTTP ${status} from '${finalUrl}'`, retryable: status >= SERVER_ERROR_STATUS || status === TOO_MANY_REQUESTS,
    details: { status, url: finalUrl, ...(excerpt === '' ? {} : { body: excerpt }) },
    ...(status === TOO_MANY_REQUESTS ? { suggestion: 'Wait before asking this host again' } : {}),
  });
}

/** "Fetching example.com" for one URL, "Fetching 3 pages" for several. */
export function urlsTitle(params: { verb: string; urls: string[] }): string {
  const { verb, urls } = params;
  const [only] = urls;
  if (urls.length !== 1 || only == null) return `${verb} ${urls.length} pages`;
  try {
    return `${verb} ${new URL(only).host}`;
  } catch {
    return `${verb} ${only}`;
  }
}
