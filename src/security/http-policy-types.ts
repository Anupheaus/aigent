/** `createHttpPolicy(options)`. Deny by default: without allowed domains every URL is refused. */
export interface HttpPolicyOptions {
  /**
   * Hosts that may be fetched: `example.com` (that name only), `*.example.com` (its subdomains, not the name itself),
   * or `**` (any public host, only with `allowAnyPublic: true`). IP literals may be listed too. Names are compared in
   * their ASCII (punycode) form, case-insensitively, without a trailing dot.
   */
  allowDomains: string[];
  /** Required to list `**`: an explicit opt-in to fetching any public host. */
  allowAnyPublic?: boolean;
  /** Ports that may be used (default 80 and 443). */
  allowPorts?: number[];
  /** Redirects followed, each one checked like the first URL (default 5). */
  maxRedirects?: number;
  /** Largest response body kept (default 1_000_000 bytes); a longer one is cut there and marked truncated. */
  maxBodyBytes?: number;
  /** Longest a request may take, body included (default 15_000 ms). */
  timeoutMs?: number;
  /** Every address a host resolves to (default: the system resolver, all addresses). Tests inject a fake DNS. */
  resolveHost?(host: string): Promise<string[]>;
  /**
   * Allows private, loopback and link-local addresses (a LAN service). Cloud metadata endpoints and reserved
   * addresses stay refused. Default false.
   */
  allowPrivateNetwork?: boolean;
}

/** Why a URL was refused. */
export type HttpDenialCode = 'invalid_url' | 'scheme_not_allowed' | 'userinfo_not_allowed' | 'port_not_allowed' | 'domain_not_allowed' | 'private_address' | 'dns_failed';

/**
 * The policy's answer: the normalised URL, every address its host resolved to (all checked) and the one to connect
 * to, or why not.
 */
export type UrlDecision =
  | { allowed: true; url: string; host: string; addresses: string[]; pinnedAddress: string }
  | { allowed: false; code: HttpDenialCode; message: string; suggestion?: string };

/** The policy's limits, with defaults applied. */
export interface HttpLimits {
  maxRedirects: number;
  maxBodyBytes: number;
  timeoutMs: number;
  allowPorts: number[];
}

/** The only authority on which URLs the web tools may fetch. */
export interface HttpPolicy {
  /** Normalises the URL, checks scheme, userinfo, port and allowlist, then resolves the host and checks every address. */
  checkUrl(url: string): Promise<UrlDecision>;
  limits: HttpLimits;
}
