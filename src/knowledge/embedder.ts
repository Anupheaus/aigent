import { createAigentError } from '../core/aigent-error.js';
import { redactSecrets } from '../providers/secret-redaction.js';
import type { Embedder } from './knowledge-types.js';
import { tokenize } from './tokenize.js';
import { normalise } from './vector-math.js';

const DEFAULT_HASH_DIMENSIONS = 256;
const FNV_OFFSET = 0x81_1c_9d_c5;
const FNV_PRIME = 0x01_00_01_93;
const TRIGRAM = 3;
/** Character trigrams count less than whole words: they only add fuzziness (plural forms, typos). */
const TRIGRAM_WEIGHT = 0.3;
const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small';
const DEFAULT_OPENAI_DIMENSIONS = 1_536;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_BATCH_SIZE = 96;
const ERROR_EXCERPT_CHARS = 300;

function fnv1a(text: string): number {
  let hash = FNV_OFFSET;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash;
}

function addFeature(params: { vector: number[]; feature: string; weight: number }): void {
  const { vector, feature, weight } = params;
  const hash = fnv1a(feature);
  const slot = hash % vector.length;
  // The top bit picks the sign, so unrelated features cancel out on average instead of piling up.
  vector[slot] = (vector[slot] ?? 0) + (hash & 0x80_00_00_00 ? -weight : weight);
}

/**
 * A deterministic, offline embedder for tests and examples: words (and identifier parts) and their character trigrams
 * hashed into `dimensions` slots, then normalised. It captures shared vocabulary, not meaning.
 */
export function hashEmbedder(options: { dimensions?: number } = {}): Embedder {
  const { dimensions = DEFAULT_HASH_DIMENSIONS } = options;
  const embedOne = (text: string): number[] => {
    const vector = new Array<number>(dimensions).fill(0);
    for (const term of tokenize(text)) {
      addFeature({ vector, feature: `w:${term}`, weight: 1 });
      const padded = `^${term}$`;
      for (let at = 0; at + TRIGRAM <= padded.length; at += 1) addFeature({ vector, feature: `t:${padded.slice(at, at + TRIGRAM)}`, weight: TRIGRAM_WEIGHT });
    }
    return normalise(vector);
  };
  return { id: `hash-v1-${dimensions}`, dimensions, embed: async texts => texts.map(embedOne) };
}

/** The fetch the OpenAI embedder needs (global `fetch` fits). */
export type EmbeddingFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;

/** `openAiEmbedder(options)`: OpenAI's (or a compatible server's) `/embeddings` endpoint. */
export interface OpenAiEmbedderOptions {
  apiKey: string;
  /** Default `text-embedding-3-small`. */
  model?: string;
  /** Default 1536; sent to the API so `text-embedding-3-*` models shorten their vectors to it. */
  dimensions?: number;
  /** Default `https://api.openai.com/v1`. */
  baseUrl?: string;
  /** Texts per request (default 96). */
  batchSize?: number;
  /** Default global `fetch`. */
  fetch?: EmbeddingFetch;
}

interface EmbeddingResponse {
  data?: { index?: number; embedding?: unknown }[];
}

function failed(params: { message: string; apiKey: string; details?: Record<string, unknown> }): Error {
  const { message, apiKey, details } = params;
  return createAigentError({ code: 'provider_failed', message: redactSecrets({ text: message, secrets: [apiKey] }), ...(details == null ? {} : { details }) });
}

/**
 * Embeddings from OpenAI's `/embeddings` API (or a compatible server), `batchSize` texts per request. A failure is not
 * retried: it becomes a `provider_failed` error with the status and a short excerpt, the API key removed.
 */
export function openAiEmbedder(options: OpenAiEmbedderOptions): Embedder {
  const { apiKey, model = DEFAULT_OPENAI_MODEL, dimensions = DEFAULT_OPENAI_DIMENSIONS, baseUrl = DEFAULT_OPENAI_BASE_URL, batchSize = DEFAULT_BATCH_SIZE } = options;
  const send: EmbeddingFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const url = `${baseUrl.replace(/\/+$/, '')}/embeddings`;
  const embedBatch = async (texts: string[], signal?: AbortSignal): Promise<number[][]> => {
    let response: Response;
    try {
      response = await send(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, input: texts, dimensions }), ...(signal == null ? {} : { signal }) });
    } catch (error) {
      throw failed({ message: `Embedding request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`, apiKey });
    }
    const text = await response.text();
    if (!response.ok) throw failed({ message: `Embedding request to ${url} failed with HTTP ${response.status}: ${text.slice(0, ERROR_EXCERPT_CHARS)}`, apiKey, details: { status: response.status } });
    let parsed: EmbeddingResponse;
    try {
      parsed = JSON.parse(text) as EmbeddingResponse;
    } catch {
      throw failed({ message: `Embedding response from ${url} is not JSON`, apiKey });
    }
    const byIndex = new Map((parsed.data ?? []).map(entry => [entry.index, entry.embedding]));
    return texts.map((_, index) => {
      const vector = byIndex.get(index);
      if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every(Number.isFinite)) {
        throw failed({ message: `Embedding response from ${url} has no ${dimensions}-number vector for input ${index}`, apiKey, details: { index } });
      }
      return vector as number[];
    });
  };
  return {
    id: `openai:${model}:${dimensions}`,
    dimensions,
    embed: async (texts, signal) => {
      const vectors: number[][] = [];
      for (let at = 0; at < texts.length; at += batchSize) vectors.push(...(await embedBatch(texts.slice(at, at + batchSize), signal)));
      return vectors;
    },
  };
}
