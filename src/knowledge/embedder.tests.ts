import { describe, expect, it } from 'vitest';
import { isAigentError } from '../core/aigent-error.js';
import { hashEmbedder, openAiEmbedder } from './embedder.js';
import { cosine } from './vector-math.js';

describe('hashEmbedder', () => {
  const embedder = hashEmbedder({ dimensions: 128 });

  it('is deterministic, normalised and sized by dimensions, with an id naming its settings', async () => {
    const [first, again] = await Promise.all([embedder.embed(['retry the request']), embedder.embed(['retry the request'])]);
    expect(first).toEqual(again);
    expect(first[0]).toHaveLength(128);
    expect(Math.hypot(...(first[0] ?? []))).toBeCloseTo(1, 10);
    expect(embedder.id).toBe('hash-v1-128');
  });

  it('places texts sharing words closer than unrelated texts', async () => {
    const [query, related, unrelated] = await embedder.embed(['configure retry backoff', 'the retry backoff is configurable', 'bananas are yellow fruit']);
    expect(cosine(query ?? [], related ?? [])).toBeGreaterThan(cosine(query ?? [], unrelated ?? []));
  });
});

interface Sent {
  url: string;
  body: { model: string; input: string[]; dimensions?: number };
  headers: Record<string, string>;
}

function fakeFetch(respond: (sent: Sent) => { status: number; body: unknown }) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: { body: string; headers: Record<string, string>; signal?: AbortSignal }) => {
    const request = { url, body: JSON.parse(init.body), headers: init.headers };
    sent.push(request);
    const { status, body } = respond(request);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { sent, fetch };
}

const API_KEY = ['sk', 'test', 'abcdefghijklmnop'].join('-');

/** Answers with one 3-number vector per input, in reverse order (the adapter must sort by index). */
function vectors(sent: Sent) {
  return { status: 200, body: { data: sent.body.input.map((text, index) => ({ index, embedding: [text.length, index, 1] })).reverse() } };
}

describe('openAiEmbedder', () => {
  it('sends batches of batchSize to /embeddings and returns vectors in input order', async () => {
    const { sent, fetch } = fakeFetch(vectors);
    const embedder = openAiEmbedder({ apiKey: API_KEY, model: 'text-embedding-3-small', dimensions: 3, batchSize: 2, fetch, baseUrl: 'https://api.example.com/v1' });
    const result = await embedder.embed(['a', 'bb', 'ccc', 'dddd', 'eeeee']);
    expect(sent.map(({ body }) => body.input)).toEqual([['a', 'bb'], ['ccc', 'dddd'], ['eeeee']]);
    expect(sent[0]).toMatchObject({ url: 'https://api.example.com/v1/embeddings', body: { model: 'text-embedding-3-small', dimensions: 3 }, headers: { authorization: `Bearer ${API_KEY}` } });
    expect(result).toEqual([[1, 0, 1], [2, 1, 1], [3, 0, 1], [4, 1, 1], [5, 0, 1]]);
    expect(embedder).toMatchObject({ id: 'openai:text-embedding-3-small:3', dimensions: 3 });
    expect(await embedder.embed([])).toEqual([]);
  });

  it('does not retry, and maps errors without the key', async () => {
    const { sent, fetch } = fakeFetch(() => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${API_KEY}` } } }));
    const embedder = openAiEmbedder({ apiKey: API_KEY, dimensions: 3, fetch });
    const failure = await embedder.embed(['x']).catch((error: unknown) => error);
    expect(sent).toHaveLength(1);
    expect(isAigentError(failure) && failure.code).toBe('provider_failed');
    expect(String((failure as Error).message)).toMatch(/401/);
    expect(JSON.stringify({ message: (failure as Error).message, details: (failure as { details?: unknown }).details })).not.toContain(API_KEY);
  });

  it('refuses answers of the wrong shape or size', async () => {
    const wrongSize = openAiEmbedder({ apiKey: API_KEY, dimensions: 4, fetch: fakeFetch(vectors).fetch });
    await expect(wrongSize.embed(['x'])).rejects.toMatchObject({ code: 'provider_failed' });
    const missing = openAiEmbedder({ apiKey: API_KEY, dimensions: 3, fetch: fakeFetch(() => ({ status: 200, body: { data: [] } })).fetch });
    await expect(missing.embed(['x'])).rejects.toMatchObject({ code: 'provider_failed' });
  });
});
