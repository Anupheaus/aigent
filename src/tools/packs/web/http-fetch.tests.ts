import { describe, expect, it } from 'vitest';
import { call, entriesOf } from '../fs/fs-tools.test-support.js';
import { createHttpFetch } from './http-fetch.js';
import { fakeWeb, redirectTo, respond } from './web-tools.test-support.js';

const LATIN1_CAFE = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);

describe('http_fetch', () => {
  it('fetches through allowed redirects, decoding text by charset', async () => {
    const { deps, access } = fakeWeb({ routes: {
      'https://example.com/old': redirectTo('https://docs.example.com/new'),
      'https://docs.example.com/new': respond({ body: 'café ☕', headers: { 'content-type': 'text/plain; charset=utf-8', etag: '"v1"', 'set-cookie': 'session=1' } }),
      'https://example.com/latin': respond({ body: LATIN1_CAFE, headers: { 'content-type': 'text/plain; charset=ISO-8859-1' } }),
    } });
    const entries = entriesOf(await call({ tool: createHttpFetch(deps), items: [{ url: 'https://example.com/old', headers: { accept: 'text/plain' } }, { url: 'https://example.com/latin' }] }));
    expect(entries[0]?.result).toEqual({
      url: 'https://example.com/old', finalUrl: 'https://docs.example.com/new', status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', etag: '"v1"' },
      contentType: 'text/plain; charset=utf-8', bodyBytes: 9, truncated: false, redirected: true, bodyText: 'café ☕',
    });
    expect(entries[1]?.result).toMatchObject({ bodyText: 'café', redirected: false });
    expect(access.requests[0]?.headers).toEqual({ 'user-agent': 'aigent/0.0.1', accept: 'text/plain' });
  });

  it('marks a body cut at the byte cap, and returns no body for HEAD or binary content', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]);
    const { deps } = fakeWeb({ policy: { maxBodyBytes: 10 }, routes: {
      'https://example.com/long': respond({ body: 'abcdefghijklmnopqrstuvwxyz' }),
      'https://example.com/logo.png': respond({ body: png, headers: { 'content-type': 'image/png' } }),
      'https://example.com/head': respond({ body: 'ignored' }),
    } });
    const entries = entriesOf(await call({ tool: createHttpFetch(deps), items: [{ url: 'https://example.com/long' }, { url: 'https://example.com/logo.png' }, { url: 'https://example.com/head', method: 'HEAD' }] }));
    expect(entries[0]?.result).toMatchObject({ truncated: true, bodyBytes: 10, bodyText: 'abcdefghij\n[… body truncated at 10 bytes]' });
    expect(entries[1]?.result).toMatchObject({ binary: true, bodyBytes: 8, contentType: 'image/png' });
    expect(entries[1]?.result).not.toHaveProperty('bodyText');
    expect(entries[2]?.result).not.toHaveProperty('bodyText');
  });

  it('turns error statuses into item failures with a short body excerpt; 5xx and 429 may be retried', async () => {
    const { deps } = fakeWeb({ routes: {
      'https://example.com/busy': respond({ status: 503, body: 'try later' }),
      'https://example.com/slow-down': respond({ status: 429, body: '' }),
    } });
    const entries = entriesOf(await call({ tool: createHttpFetch(deps), items: [{ url: 'https://example.com/missing' }, { url: 'https://example.com/busy' }, { url: 'https://example.com/slow-down' }] }));
    expect(entries[0]).toMatchObject({ ok: false, error: { code: 'http_error', retryable: false, details: { status: 404, body: 'not found' } } });
    expect(entries[1]).toMatchObject({ ok: false, error: { code: 'http_error', retryable: true, details: { status: 503 } } });
    expect(entries[2]).toMatchObject({ ok: false, error: { retryable: true, suggestion: expect.stringMatching(/Wait/) } });
  });

  it('refuses URLs the policy denies as denied item failures, at the first URL or a redirect, without requesting them', async () => {
    const { deps, access } = fakeWeb({ routes: { 'https://example.com/to-metadata': redirectTo('http://169.254.169.254/latest/meta-data/') } });
    const entries = entriesOf(await call({ tool: createHttpFetch(deps), items: [{ url: 'https://evil.net/' }, { url: 'https://internal.example.com/' }, { url: 'https://example.com/to-metadata' }, { url: 'http://[::1]/' }] }));
    expect(entries.map(({ ok, error }) => [ok, error?.category, error?.code])).toEqual([
      [false, 'denied', 'domain_not_allowed'], [false, 'denied', 'private_address'], [false, 'denied', 'private_address'], [false, 'denied', 'private_address'],
    ]);
    expect(entries[0]?.error).toMatchObject({ suggestion: expect.stringContaining('example.com') });
    expect(access.requests.map(({ url }) => url)).toEqual(['https://example.com/to-metadata']);
  });

  it('marks a name that did not resolve as retryable (DNS failures are often transient), other refusals not', async () => {
    const { deps } = fakeWeb({ routes: {} });
    const entries = entriesOf(await call({ tool: createHttpFetch(deps), items: [{ url: 'https://unknown.example.com/' }, { url: 'https://evil.net/' }] }));
    expect(entries.map(({ error }) => [error?.category, error?.code, error?.retryable])).toEqual([['denied', 'dns_failed', true], ['denied', 'domain_not_allowed', false]]);
  });

  it('accepts only the allowlisted request headers', async () => {
    const { deps } = fakeWeb({ routes: {} });
    const executed = await call({ tool: createHttpFetch(deps), items: [{ url: 'https://example.com/', headers: { authorization: 'Bearer x' } }] });
    expect(executed.envelope).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
  });
});
