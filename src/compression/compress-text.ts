import { createHash } from 'node:crypto';
import { canonicalJson } from '../core/canonical-json.js';
import { describeError } from '../core/describe-value.js';
import { estimateTokens } from '../telemetry/estimate-tokens.js';
import type { CompressionCache, CompressedEntry } from './compression-cache.js';
import type { ResolvedCompression } from './compression-options.js';
import type { CompressedText, CompressionField } from './compressor-types.js';
import { findProtectedSpans } from './protect.js';

const HASH_ALGORITHM = 'sha256';

export interface CompressTextParams {
  text: string;
  /** What the text is, for warnings and telemetry. */
  field: CompressionField;
  compression: ResolvedCompression;
  cache: CompressionCache;
  now(): number;
  signal?: AbortSignal;
}

/** sha-256 over the source, the compressor's id and version, and every parameter that changes its output. */
function cacheKey(params: { text: string; compression: ResolvedCompression }): string {
  const { text, compression: { compressor: { id, version }, targetRatio, forceKeep } } = params;
  return createHash(HASH_ALGORITHM).update(canonicalJson({ source: text, compressor: { id, version }, params: { targetRatio, forceKeep } })).digest('hex');
}

/** The exact substrings the output must still contain. */
function requiredSpans(params: { text: string; forceKeep: string[] }): string[] {
  const { text, forceKeep } = params;
  return [...findProtectedSpans(text), ...forceKeep.filter(entry => text.includes(entry))];
}

/** Whole occurrences of `span` in `text`: a span that starts or ends with a word character must not touch another. */
function occurrences(params: { text: string; span: string }): number {
  const { text, span } = params;
  const escaped = span.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = /^\w/.test(span) ? '(?<!\\w)' : '';
  const after = /\w$/.test(span) ? '(?!\\w)' : '';
  return [...text.matchAll(new RegExp(`${before}${escaped}${after}`, 'g'))].length;
}

/** Every required span occurs in the output at least as often as in the source ("not" inside "notes" does not count). */
function keepsRequired(params: { text: string; output: string; required: string[] }): boolean {
  const { text, output, required } = params;
  return [...new Set(required)].every(span => occurrences({ text: output, span }) >= occurrences({ text, span }));
}

function rejectedWarning(field: CompressionField): string {
  return `Compression of ${field} dropped protected content and was ignored`;
}

interface ResultParams {
  text: string;
  field: CompressionField;
  key: string;
  entry: CompressedEntry;
  cacheHit: boolean;
  latencyMs: number;
  isSkipped?: boolean;
}

function toResult(params: ResultParams): CompressedText {
  const { text, field, key, entry, cacheHit, latencyMs, isSkipped = false } = params;
  const originalTokens = estimateTokens(text);
  const compressedTokens = estimateTokens(entry.text);
  return {
    text: entry.text, originalText: text, originalTokens, compressedTokens, ratio: originalTokens === 0 ? 1 : compressedTokens / originalTokens, cacheHit, key, latencyMs, isSkipped,
    ...(entry.isRejected ? { warning: rejectedWarning(field) } : {}),
  };
}

/** Runs the compressor and checks its output; a failure or a dropped protected span keeps the original. */
async function runCompressor(params: CompressTextParams & { recordedAt: number }): Promise<{ entry: CompressedEntry; failure?: string }> {
  const { text, compression: { compressor, targetRatio, forceKeep }, recordedAt, signal } = params;
  const base = { compressorId: compressor.id, compressorVersion: compressor.version, recordedAt };
  const required = requiredSpans({ text, forceKeep });
  try {
    const { text: output } = await compressor.compress({ text, targetRatio, protect: required, ...(signal == null ? {} : { signal }) });
    if (!keepsRequired({ text, output, required })) return { entry: { ...base, text, isRejected: true } };
    // Output that is not shorter is no compression at all; the original is sent as is.
    return { entry: { ...base, text: output.length < text.length ? output : text, isRejected: false } };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { entry: { ...base, text, isRejected: false }, failure: describeError(error) };
  }
}

/**
 * Compresses `text` once per cache key and serves the stored result from then on, so the same input, compressor
 * and parameters always give byte-identical text. Text under `minTokens` is returned unchanged. Output that lost any
 * protected span (or `forceKeep` entry) is rejected: the original is used and the result carries a warning.
 */
export async function compressText(params: CompressTextParams): Promise<CompressedText> {
  const { text, field, compression: { minTokens }, cache, now } = params;
  const key = cacheKey(params);
  const unchanged: CompressedEntry = { text, isRejected: false, compressorId: '', compressorVersion: '', recordedAt: 0 };
  if (estimateTokens(text) < minTokens) return toResult({ text, field, key, entry: unchanged, cacheHit: false, latencyMs: 0, isSkipped: true });
  const cached = await cache.get(key);
  if (cached != null) return toResult({ text, field, key, entry: cached, cacheHit: true, latencyMs: 0 });
  const startedAt = now();
  const { entry, failure } = await runCompressor({ ...params, recordedAt: startedAt });
  const latencyMs = now() - startedAt;
  // A failure is not cached: the next call may find the compressor available again.
  if (failure != null) return { ...toResult({ text, field, key, entry, cacheHit: false, latencyMs }), warning: `Compression of ${field} failed (${failure}) and was ignored` };
  await cache.set({ key, entry });
  return toResult({ text, field, key, entry, cacheHit: false, latencyMs });
}
