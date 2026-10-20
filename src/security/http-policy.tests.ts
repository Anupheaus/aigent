import { describe, expect, it } from 'vitest';
import { createHttpPolicy } from './http-policy.js';
import type { HttpPolicyOptions } from './http-policy-types.js';

/** A fake resolver: names to addresses; anything else fails like an unknown name. */
function dns(table: Record<string, string[]>): (host: string) => Promise<string[]> {
  return async host => {
    const addresses = table[host];
    if (addresses == null) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    return addresses;
  };
}

const PUBLIC_DNS = dns({
  'example.com': ['93.184.216.34'], 'api.example.com': ['93.184.216.35'], 'a.b.example.com': ['93.184.216.36'], 'evilexample.com': ['1.2.3.4'],
  'example.com.evil.net': ['1.2.3.5'], 'xn--bcher-kva.example': ['1.2.3.6'], 'internal.example.com': ['10.0.0.5'], 'mixed.example.com': ['93.184.216.37', '127.0.0.1'],
  'v6.example.com': ['2606:4700::1111'], 'v6private.example.com': ['fd00::1'],
});

function policy(options: Partial<HttpPolicyOptions> = {}) {
  return createHttpPolicy({ allowDomains: ['example.com', '*.example.com', 'bücher.example'], resolveHost: PUBLIC_DNS, ...options });
}

describe('HttpPolicy domain allowlist', () => {
  it.each([
    ['http://example.com/', true],
    ['https://EXAMPLE.com./path?q=1', true],
    ['https://api.example.com/', true],
    ['https://a.b.example.com/', true],
    ['https://evilexample.com/', false],
    ['https://example.com.evil.net/', false],
    ['http://bücher.example/', true],
    ['http://xn--bcher-kva.example/', true],
  ])('%s allowed: %s', async (url, allowed) => {
    expect((await policy().checkUrl(url)).allowed).toBe(allowed);
  });

  it('matches exact entries only on the name itself, and wildcard entries only on subdomains', async () => {
    const exact = createHttpPolicy({ allowDomains: ['example.com'], resolveHost: PUBLIC_DNS });
    expect(await exact.checkUrl('https://api.example.com/')).toMatchObject({ allowed: false, code: 'domain_not_allowed' });
    const wildcard = createHttpPolicy({ allowDomains: ['*.example.com'], resolveHost: PUBLIC_DNS });
    expect(await wildcard.checkUrl('https://example.com/')).toMatchObject({ allowed: false, code: 'domain_not_allowed' });
  });

  it('denies everything without an allowlist, and refuses ** unless allowAnyPublic', async () => {
    expect(await createHttpPolicy({ allowDomains: [], resolveHost: PUBLIC_DNS }).checkUrl('https://example.com/')).toMatchObject({ allowed: false, code: 'domain_not_allowed' });
    expect(() => createHttpPolicy({ allowDomains: ['**'] })).toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringMatching(/allowAnyPublic/) }));
    const any = createHttpPolicy({ allowDomains: ['**'], allowAnyPublic: true, resolveHost: PUBLIC_DNS });
    expect(await any.checkUrl('https://evilexample.com/')).toMatchObject({ allowed: true, addresses: ['1.2.3.4'], pinnedAddress: '1.2.3.4' });
  });
});

describe('HttpPolicy URL rules', () => {
  it.each([
    ['ftp://example.com/', 'scheme_not_allowed'],
    ['file:///etc/passwd', 'scheme_not_allowed'],
    ['javascript:alert(1)', 'scheme_not_allowed'],
    ['http://user@example.com/', 'userinfo_not_allowed'],
    ['http://user:pass@example.com/', 'userinfo_not_allowed'],
    ['http://example.com:8080/', 'port_not_allowed'],
    ['not a url', 'invalid_url'],
    ['http://unknown.example.com/', 'dns_failed'],
  ])('%s is refused with %s', async (url, code) => {
    expect(await policy().checkUrl(url)).toMatchObject({ allowed: false, code, message: expect.any(String) });
  });

  it('allows listed ports, and normalises the URL it allows', async () => {
    const ports = createHttpPolicy({ allowDomains: ['example.com'], allowPorts: [8443], resolveHost: PUBLIC_DNS });
    expect(await ports.checkUrl('https://Example.COM.:8443/a/../b')).toMatchObject({ allowed: true, url: 'https://example.com:8443/b', host: 'example.com' });
    expect(await ports.checkUrl('https://example.com/')).toMatchObject({ allowed: false, code: 'port_not_allowed' });
  });

  it('applies defaults and exposes its limits', () => {
    expect(policy().limits).toEqual({ maxRedirects: 5, maxBodyBytes: 1_000_000, timeoutMs: 15_000, allowPorts: [80, 443] });
  });
});

describe('HttpPolicy SSRF', () => {
  const anyPublic = (): ReturnType<typeof createHttpPolicy> => createHttpPolicy({ allowDomains: ['**'], allowAnyPublic: true, resolveHost: PUBLIC_DNS });

  it.each([
    'http://127.0.0.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.1/', 'http://0x7f000001/', 'http://127.1/', 'http://127.0.0.1./',
    'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.0.1/', 'http://100.64.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://169.254.1.1/',
    'http://0.0.0.0/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[fc00::1]/', 'http://[fe80::1]/', 'http://[::]/',
    'http://localhost/', 'http://LOCALHOST./', 'http://api.localhost/', 'http://a@127.0.0.1/',
    'http://internal.example.com/', 'http://mixed.example.com/', 'http://v6private.example.com/',
  ])('blocks %s even when any public host is allowed', async url => {
    const decision = await anyPublic().checkUrl(url);
    expect(decision.allowed).toBe(false);
  });

  it('allows public addresses, IPv6 included, and pins the address it checked', async () => {
    expect(await anyPublic().checkUrl('https://v6.example.com/')).toMatchObject({ allowed: true, pinnedAddress: '2606:4700::1111' });
    expect(await anyPublic().checkUrl('http://93.184.216.34/')).toMatchObject({ allowed: true, pinnedAddress: '93.184.216.34' });
  });

  it('never resolves a name that is not allowed, and says which address is private', async () => {
    const resolved: string[] = [];
    const tracked = createHttpPolicy({ allowDomains: ['*.example.com'], resolveHost: async host => { resolved.push(host); return PUBLIC_DNS(host); } });
    await tracked.checkUrl('https://evilexample.com/');
    expect(resolved).toEqual([]);
    expect(await tracked.checkUrl('https://internal.example.com/')).toMatchObject({ allowed: false, code: 'private_address', message: expect.stringContaining('10.0.0.5') });
  });

  it('lets allowPrivateNetwork reach private addresses but never metadata endpoints', async () => {
    const lan = createHttpPolicy({ allowDomains: ['**'], allowAnyPublic: true, allowPrivateNetwork: true, resolveHost: PUBLIC_DNS });
    expect((await lan.checkUrl('http://internal.example.com/')).allowed).toBe(true);
    expect((await lan.checkUrl('http://169.254.169.254/')).allowed).toBe(false);
    expect((await lan.checkUrl('http://0.0.0.0/')).allowed).toBe(false);
  });
});
