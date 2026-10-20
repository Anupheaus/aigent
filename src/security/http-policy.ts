import { lookup } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import { classifyAddress } from './ip-classify.js';
import type { AddressKind } from './ip-classify.js';
import type { HttpLimits, HttpPolicy, HttpPolicyOptions, UrlDecision } from './http-policy-types.js';

const DEFAULT_PORTS = [80, 443];
const DEFAULT_MAX_REDIRECTS = 5;
const MAX_REDIRECTS_LIMIT = 20;
const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PORT = 65_535;
const ANY_HOST = '**';
const WILDCARD_PREFIX = '*.';
const SCHEME_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

const optionsSchema = z.object({
  allowDomains: z.array(z.string().min(1)),
  allowAnyPublic: z.boolean().optional(),
  allowPorts: z.array(z.number().int().min(1).max(MAX_PORT)).min(1).optional(),
  maxRedirects: z.number().int().min(0).max(MAX_REDIRECTS_LIMIT).optional(),
  maxBodyBytes: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  resolveHost: z.custom<(host: string) => Promise<string[]>>(value => typeof value === 'function', 'resolveHost must be a function').optional(),
  allowPrivateNetwork: z.boolean().optional(),
}).strict();

/** Kinds `allowPrivateNetwork` opens; metadata, reserved and invalid addresses are never fetched. */
const PRIVATE_KINDS: ReadonlySet<AddressKind> = new Set(['private', 'loopback', 'link-local']);

/** A host as compared: ASCII (punycode), lower case, no trailing dot. */
function normaliseHost(host: string): string {
  const trimmed = host.toLowerCase().replace(/\.+$/, '');
  if (trimmed.startsWith('[')) return trimmed;
  const ascii = domainToASCII(trimmed);
  return ascii === '' ? trimmed : ascii;
}

/** One allowlist entry, normalised: exact names and `*.` subdomain patterns; anything else is a definition error. */
function normaliseEntry(entry: string): string {
  if (entry === ANY_HOST) return entry;
  const isWildcard = entry.startsWith(WILDCARD_PREFIX);
  const name = isWildcard ? entry.slice(WILDCARD_PREFIX.length) : entry;
  if (name === '' || name.includes('*') || /[/:@\s]/.test(name.replace(/^\[.*\]$/, ''))) {
    throw createAigentError({ code: 'invalid_input', message: `Invalid allowDomains entry '${entry}': expected a host name ('example.com'), a subdomain pattern ('*.example.com') or '**'`, details: { entry } });
  }
  return (isWildcard ? WILDCARD_PREFIX : '') + normaliseHost(name);
}

function isListed(params: { host: string; entries: readonly string[] }): boolean {
  const { host, entries } = params;
  return entries.some(entry => {
    if (entry === ANY_HOST) return true;
    if (entry.startsWith(WILDCARD_PREFIX)) return host.endsWith(entry.slice(1)) && host.length > entry.length - 1;
    return host === entry;
  });
}

async function systemResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address);
}

/** Validates the options; throws `invalid_input` (`**` needs `allowAnyPublic`). */
function parseOptions(options: HttpPolicyOptions): HttpPolicyOptions {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) throw createAigentError({ code: 'invalid_input', message: `Invalid HTTP policy options: ${describeIssues(parsed.error)}`, details: { issues: parsed.error.issues.length } });
  if (options.allowDomains.includes(ANY_HOST) && options.allowAnyPublic !== true) {
    throw createAigentError({ code: 'invalid_input', message: "allowDomains '**' (any public host) needs allowAnyPublic: true", details: { entry: ANY_HOST } });
  }
  return options;
}

/**
 * The URL authority for the web tools, deny by default: http(s) only, no userinfo, allowed ports, allowlisted hosts,
 * and every address the host resolves to must be public (private, loopback, link-local, metadata and reserved
 * addresses are refused in every textual form). Call it for the first URL and again for every redirect.
 */
export function createHttpPolicy(options: HttpPolicyOptions): HttpPolicy {
  const { allowDomains, allowPorts = DEFAULT_PORTS, maxRedirects = DEFAULT_MAX_REDIRECTS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS, resolveHost = systemResolve, allowPrivateNetwork = false } = parseOptions(options);
  const entries = allowDomains.map(normaliseEntry);
  const limits: HttpLimits = { maxRedirects, maxBodyBytes, timeoutMs, allowPorts: [...allowPorts] };
  const deny = (denial: Omit<Extract<UrlDecision, { allowed: false }>, 'allowed'>): UrlDecision => ({ allowed: false, ...denial });
  const isBlocked = (kind: AddressKind): boolean => kind !== 'public' && !(allowPrivateNetwork && PRIVATE_KINDS.has(kind));

  async function checkUrl(raw: string): Promise<UrlDecision> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return deny({ code: 'invalid_url', message: `'${raw}' is not an absolute URL`, suggestion: 'Give a full URL such as https://example.com/page' });
    }
    if (SCHEME_PORTS[url.protocol] == null) return deny({ code: 'scheme_not_allowed', message: `Scheme '${url.protocol}' is not allowed; only http and https are` });
    if (url.username !== '' || url.password !== '') return deny({ code: 'userinfo_not_allowed', message: `URLs with credentials (user@host) are not allowed: '${url.host}'` });
    const port = url.port === '' ? SCHEME_PORTS[url.protocol] as number : Number(url.port);
    if (!allowPorts.includes(port)) return deny({ code: 'port_not_allowed', message: `Port ${port} is not allowed (allowed: ${allowPorts.join(', ')})` });
    const host = normaliseHost(url.hostname);
    url.hostname = host;
    const literal = host.startsWith('[') ? host.slice(1, -1) : host;
    const isLiteral = classifyAddress(literal).kind !== 'invalid';
    if (!allowPrivateNetwork && (host === 'localhost' || host.endsWith('.localhost'))) return deny({ code: 'private_address', message: `'${host}' is a local host name` });
    if (!isListed({ host, entries })) return deny({ code: 'domain_not_allowed', message: `Host '${host}' is not in the allowed domains`, suggestion: entries.length === 0 ? 'No domains are allowed for web access' : `Allowed: ${entries.join(', ')}` });
    let addresses: string[];
    try {
      addresses = isLiteral ? [literal] : await resolveHost(host);
    } catch (error) {
      return deny({ code: 'dns_failed', message: `'${host}' could not be resolved: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (addresses.length === 0) return deny({ code: 'dns_failed', message: `'${host}' resolved to no addresses` });
    for (const address of addresses) {
      const { kind } = classifyAddress(address);
      // Any one non-public answer refuses the host: a resolver may hand out either address on the next lookup.
      if (isBlocked(kind)) return deny({ code: 'private_address', message: `'${host}' resolves to ${address} (${kind}), which may not be fetched` });
    }
    return { allowed: true, url: url.href, host, addresses, pinnedAddress: addresses[0] as string };
  }

  return { checkUrl, limits };
}
