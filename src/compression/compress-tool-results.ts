import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { compressText } from './compress-text.js';
import type { CompressionCache } from './compression-cache.js';
import type { ResolvedCompression } from './compression-options.js';
import type { CompressionRecord } from './compressor-types.js';

/** Above this share of code-like lines a result counts as code. */
const CODE_LINE_SHARE = 0.3;
const CODE_LINE = /[;{}]\s*$|^\s*(?:import|export|function|const|let|def|class|return)\b/;
const DIFF_MARKER = /^(?:diff --git |@@ |\+\+\+ |--- )/m;

/** Code, diffs and JSON lose meaning when words are dropped, so they are compressed only with `'allow-code'`. */
export function looksLikeCode(text: string): boolean {
  if (text.includes('```') || /^\s*[[{]/.test(text) || DIFF_MARKER.test(text)) return true;
  const lines = text.split('\n').filter(line => line.trim() !== '');
  return lines.length > 0 && lines.filter(line => CODE_LINE.test(line)).length / lines.length > CODE_LINE_SHARE;
}

/** The note after a compressed result, so the model knows it can get the original back. */
export function compressedResultNote(params: { originalTokens: number; handle: string }): string {
  const { originalTokens, handle } = params;
  return `[compressed from ~${originalTokens} tokens; full original: result_original handle ${handle}]`;
}

export interface CompressToolResultsParams {
  executed: ExecutedToolCall[];
  registry: ToolRegistry;
  compression: ResolvedCompression;
  cache: CompressionCache;
  now(): number;
  /** Keeps a verbatim original and returns its `result_original` handle. */
  keepOriginal(text: string): string;
  signal: AbortSignal;
}

export interface CompressedToolResults {
  executed: ExecutedToolCall[];
  records: CompressionRecord[];
  warnings: string[];
}

/**
 * Compresses the prose results of tools declared `compressible` as they are committed to history (when `applyTo`
 * includes `toolResults`). Only successful string results; code-like ones only with `compressible: 'allow-code'`.
 * The compressed text is what is stored and sent from then on (so the prefix stays byte-stable); the original is
 * kept under a `result_original` handle.
 */
export async function compressToolResults(params: CompressToolResultsParams): Promise<CompressedToolResults> {
  const { executed, registry, compression, cache, now, keepOriginal, signal } = params;
  const records: CompressionRecord[] = [];
  const warnings: string[] = [];
  if (!compression.applyTo.includes('toolResults')) return { executed, records, warnings };
  const compressed: ExecutedToolCall[] = [];
  for (const call of executed) {
    const { envelope } = call;
    const compressible = registry.get(envelope.tool)?.compressible;
    const isCandidate = envelope.ok && typeof envelope.result === 'string' && compressible != null && compressible !== false;
    if (!isCandidate || (compressible !== 'allow-code' && looksLikeCode(envelope.result as string))) { compressed.push(call); continue; }
    const original = envelope.result as string;
    const result = await compressText({ text: original, field: 'toolResult', compression, cache, now, signal });
    if (result.warning != null) warnings.push(result.warning);
    if (!result.isSkipped) records.push({ field: 'toolResult', originalTokens: result.originalTokens, compressedTokens: result.compressedTokens, ratio: result.ratio, latencyMs: result.latencyMs, cacheHit: result.cacheHit });
    if (result.text === original) { compressed.push(call); continue; }
    const handle = keepOriginal(original);
    compressed.push({ ...call, envelope: { ...envelope, result: `${result.text}\n${compressedResultNote({ originalTokens: result.originalTokens, handle })}` } });
  }
  return { executed: compressed, records, warnings };
}
