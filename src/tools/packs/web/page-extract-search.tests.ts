import { describe, expect, it } from 'vitest';
import { createHttpPolicy } from '../../../security/http-policy.js';
import { call, entriesOf } from '../fs/fs-tools.test-support.js';
import { createPageExtract } from './page-extract.js';
import type { SearchProvider } from './search-provider.js';
import { createWebSearch } from './web-search.js';
import { webTools } from './web-tools.js';
import { fakeWeb, html, respond } from './web-tools.test-support.js';

const PAGE = '<html><head><title>Guide</title><script>steal()</script></head><body><nav><a href="/">Home</a></nav><main><h1>Install</h1><p>Run <code>npm i</code>.</p><a href="setup">Setup</a></main></body></html>';

describe('page_extract', () => {
  it('returns readable text, headings and absolute links of HTML pages, and text of plain pages', async () => {
    const { deps } = fakeWeb({ routes: {
      'https://docs.example.com/guide/': html(PAGE),
      'https://docs.example.com/notes.txt': respond({ body: '  plain notes  ' }),
      'https://docs.example.com/file.zip': respond({ body: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'application/zip' } }),
    } });
    const entries = entriesOf(await call({ tool: createPageExtract(deps), items: [{ url: 'https://docs.example.com/guide/' }, { url: 'https://docs.example.com/notes.txt' }, { url: 'https://docs.example.com/file.zip' }] }));
    expect(entries[0]?.result).toEqual({
      url: 'https://docs.example.com/guide/', finalUrl: 'https://docs.example.com/guide/', title: 'Guide', text: 'Install\nRun npm i.\nSetup', truncated: false,
      headings: [{ level: 1, text: 'Install' }], links: [{ text: 'Home', url: 'https://docs.example.com/' }, { text: 'Setup', url: 'https://docs.example.com/guide/setup' }],
    });
    expect(entries[1]?.result).toMatchObject({ text: 'plain notes', headings: [], links: [] });
    expect(entries[2]).toMatchObject({ ok: false, error: { code: 'unsupported_content', suggestion: expect.stringContaining('http_fetch') } });
  });

  it('fits a batch of long pages within the result budget, each page cut on its own and pageable by offset (review I3)', async () => {
    const paragraphs = (label: string) => Array.from({ length: 600 }, (_unused, index) => `<p>${label} "line" ${index} of the page.</p>`).join('');
    const urls = ['a', 'b', 'c'].map(label => `https://example.com/${label}`);
    const { deps } = fakeWeb({ routes: Object.fromEntries(urls.map((url, index) => [url, html(`<main>${paragraphs(String(index))}</main>`)])) });
    const tool = createPageExtract(deps);
    const executed = await call({ tool, items: urls.map(url => ({ url })) });
    expect(executed.size.truncated).toBe(false);
    const entries = entriesOf(executed);
    expect(entries.map(({ result }) => [result?.truncated, typeof result?.nextOffset])).toEqual([[true, 'number'], [true, 'number'], [true, 'number']]);
    const first = entries[0]?.result as { text: string; nextOffset: number; totalChars: number };
    expect(first.text.startsWith('0 "line" 0 of the page.')).toBe(true);
    // Paging: the next call continues exactly where the first stopped, until the whole text has been read.
    let text = first.text;
    let offset: number | undefined = first.nextOffset;
    while (offset != null) {
      const [next] = entriesOf(await call({ tool, items: [{ url: urls[0], offset }] }));
      const page = next?.result as { text: string; nextOffset?: number; offset: number };
      expect(page.offset).toBe(offset);
      text += page.text;
      offset = page.nextOffset;
    }
    expect(text).toHaveLength(first.totalChars);
    expect(text.endsWith('0 "line" 599 of the page.')).toBe(true);
  });

  it('refuses a selector argument: only url and maxChars are accepted', async () => {
    const { deps } = fakeWeb({ routes: {} });
    expect((await call({ tool: createPageExtract(deps), items: [{ url: 'https://example.com/', selector: 'main' }] })).envelope).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
  });
});

describe('web_search', () => {
  const provider = (results: unknown): SearchProvider & { queries: string[] } => {
    const queries: string[] = [];
    return { name: 'fake', queries, search: async (query, { limit }) => { queries.push(`${query}:${limit}`); return results as never; } };
  };

  it('dedupes results by URL, honours the limit and drops malformed hits', async () => {
    const hits = [
      { title: 'A', url: 'https://a.example/x', snippet: 'one' }, { title: 'A again', url: 'https://A.example/x/#top', snippet: 'dup' },
      { title: 'bad', url: 'javascript:alert(1)', snippet: '' }, { title: 'B', url: 'https://b.example/', snippet: 'two' }, { title: 'C', url: 'https://c.example/', snippet: 'three' },
    ];
    const search = provider(hits);
    const entries = entriesOf(await call({ tool: createWebSearch(search), items: [{ query: 'q', limit: 2 }] }));
    expect(entries[0]?.result).toEqual({ query: 'q', provider: 'fake', total: 2, results: [{ title: 'A', url: 'https://a.example/x', snippet: 'one' }, { title: 'B', url: 'https://b.example/', snippet: 'two' }] });
    expect(search.queries).toEqual(['q:2']);
  });

  it('turns a provider failure into a search_failed item, and caps queries and limits', async () => {
    const failing: SearchProvider = { name: 'down', search: async () => { throw new Error('quota exceeded'); } };
    const entries = entriesOf(await call({ tool: createWebSearch(failing), items: [{ query: 'q' }] }));
    expect(entries[0]).toMatchObject({ ok: false, error: { code: 'search_failed', retryable: true, message: expect.stringContaining('quota exceeded') } });
    const tooMany = await call({ tool: createWebSearch(failing), items: Array.from({ length: 6 }, () => ({ query: 'q' })) });
    expect(tooMany.envelope).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect((await call({ tool: createWebSearch(failing), items: [{ query: 'q', limit: 11 }] })).envelope).toMatchObject({ ok: false });
  });
});

describe('webTools', () => {
  it('registers web_search only with a provider, and needs a policy', () => {
    const policy = createHttpPolicy({ allowDomains: ['example.com'] });
    expect(webTools({ policy }).map(({ name }) => name)).toEqual(['http_fetch', 'page_extract']);
    expect(webTools({ policy, search: { name: 's', search: async () => [] } }).map(({ name }) => name)).toEqual(['http_fetch', 'page_extract', 'web_search']);
    expect(() => webTools({} as never)).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
  });

  it('declares caching, content kinds and fidelity for each tool', () => {
    const policy = createHttpPolicy({ allowDomains: ['example.com'] });
    const tools = webTools({ policy, search: { name: 's', search: async () => [] } });
    expect(tools.map(({ name, deterministic, cache, cacheTtlMs, contentKind, fidelity, hasSideEffects }) => ({ name, deterministic, cache, cacheTtlMs, contentKind, fidelity, hasSideEffects }))).toEqual([
      { name: 'http_fetch', deterministic: false, cache: true, cacheTtlMs: 300_000, contentKind: 'web-page', fidelity: 'verbatim', hasSideEffects: false },
      { name: 'page_extract', deterministic: false, cache: true, cacheTtlMs: 300_000, contentKind: 'web-page', fidelity: 'lossy-ok', hasSideEffects: false },
      { name: 'web_search', deterministic: false, cache: true, cacheTtlMs: 300_000, contentKind: 'search-hits', fidelity: 'lossy-ok', hasSideEffects: false },
    ]);
  });
});
