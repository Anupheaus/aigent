import { createHash } from 'node:crypto';
import { createAigentError } from '../core/aigent-error.js';
import { canonicalJson } from '../core/canonical-json.js';
import { raceSignal } from '../core/race-signal.js';
import { describeError } from '../core/describe-value.js';
import { estimateTokens } from '../telemetry/estimate-tokens.js';
import type { CompressionCache, CompressedEntry } from './compression-cache.js';
import type { ResolvedCompression } from './compression-options.js';
import type { CompressedText, CompressionField } from './compressor-types.js';
import { findProtectedSpans } from './protect.js';
import { keepsProtected, PROTECTION_VERSION } from './protection-check.js';

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

/** sha-256 over the source, the compressor's id and version, every parameter that changes its output and the protection rules. */
function cacheKey(params: { text: string; compression: ResolvedCompression }): string {
  const { text, compression: { compressor: { id, version }, targetRatio, forceKeep } } = params;
  return createHash(HASH_ALGORITHM).update(canonicalJson({ source: text, compressor: { id, version }, params: { targetRatio, forceKeep }, protection: PROTECTION_VERSION })).digest('hex');
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
  isFailed?: boolean;
}

function toResult(params: ResultParams): CompressedText {
  const { text, field, key, entry, cacheHit, latencyMs, isSkipped = false, isFailed = false } = params;
  const originalTokens = estimateTokens(text);
  const compressedTokens = estimateTokens(entry.text);
  return {
    text: entry.text, originalText: text, originalTokens, compressedTokens, ratio: originalTokens === 0 ? 1 : compressedTokens / originalTokens, cacheHit, key, latencyMs, isSkipped, isFailed,
    ...(entry.isRejected ? { warning: rejectedWarning(field) } : {}),
  };
}

/** Asks the compressor, bounded by `timeoutMs` and the caller's signal; the compressor's own signal ends with either. */
async function askCompressor(params: CompressTextParams & { required: string[] }): Promise<string> {
  const { text, compression: { compressor, targetRatio, timeoutMs }, required, signal } = params;
  const call = new AbortController();
  const onAbort = (): void => call.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted === true) onAbort();
  const timer = setTimeout(() => call.abort(`the compressor did not answer within ${timeoutMs}ms`), timeoutMs);
  try {
    const raced = await raceSignal({ work: compressor.compress({ text, targetRatio, protect: required, signal: call.signal }), signal: call.signal });
    if (raced.isAborted && signal?.aborted === true) throw createAigentError({ code: 'aborted', message: `Compression was aborted: ${String(signal.reason)}` });
    if (raced.isAborted) throw createAigentError({ code: 'provider_failed', message: String(call.signal.reason), details: { compressorId: compressor.id, timeoutMs } });
    return raced.value.text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Runs the compressor and checks its output; a failure or a dropped protected span keeps the original. */
async function runCompressor(params: CompressTextParams & { recordedAt: number }): Promise<{ entry: CompressedEntry; failure?: string }> {
  const { text, compression: { compressor, forceKeep }, recordedAt, signal } = params;
  const base = { compressorId: compressor.id, compressorVersion: compressor.version, recordedAt };
  const required = findProtectedSpans(text, forceKeep);
  try {
    const output = await askCompressor({ ...params, required });
    if (!keepsProtected({ text, output, forceKeep })) return { entry: { ...base, text, isRejected: true } };
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
  // Re-checked on every hit (it is cheap): an entry from a shared store is not trusted blindly.
  const isTrusted = cached != null && (cached.isRejected || cached.text === text || keepsProtected({ text, output: cached.text, forceKeep: params.compression.forceKeep }));
  if (cached != null && isTrusted) return toResult({ text, field, key, entry: cached, cacheHit: true, latencyMs: 0 });
  const startedAt = now();
  const { entry, failure } = await runCompressor({ ...params, recordedAt: startedAt });
  const latencyMs = now() - startedAt;
  // A failure is not cached: the next call may find the compressor available again.
  if (failure != null) return { ...toResult({ text, field, key, entry, cacheHit: false, latencyMs, isFailed: true }), warning: `Compression of ${field} failed (${failure}) and was ignored` };
  await cache.set({ key, entry });
  return toResult({ text, field, key, entry, cacheHit: false, latencyMs });
}
