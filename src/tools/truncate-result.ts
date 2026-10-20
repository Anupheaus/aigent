import { describeValue } from '../core/describe-value.js';
import { CHARS_PER_TOKEN, estimateTokens } from '../telemetry/estimate-tokens.js';

/** Size of a tool result as the model would see it, before any truncation. */
export interface ResultSize {
  /** UTF-8 bytes of the serialised result. */
  resultBytes: number;
  /** Estimated tokens of the serialised result (see `estimateTokens`). */
  resultTokens: number;
  /** True when the model was shown a truncation marker instead of the result. */
  truncated: boolean;
}

export interface TruncateResultParams {
  result: unknown;
  /** The tool's budget for the model-visible result; no truncation when absent. */
  maxResultTokens?: number;
}

export interface SizedResult {
  /** What the model sees: the result itself, or the truncation marker. */
  result: unknown;
  size: ResultSize;
}

/** What replaces a result that is over its tool's `maxResultTokens`. */
interface TruncatedResult {
  truncated: true;
  note: string;
  /** The first `maxResultTokens` tokens' worth of the result's JSON text. */
  preview: string;
}

/** The JSON text the model receives; never throws, because a tool may return anything (cycles, BigInt). */
function serialise(result: unknown): string {
  try {
    return JSON.stringify(result) ?? '';
  } catch { // results JSON cannot represent are still measured, by their plain description
    return describeValue(result);
  }
}

/** Measures a result and, when it is over `maxResultTokens`, replaces it with a marker that tells the model how to get less. */
export function truncateResult(params: TruncateResultParams): SizedResult {
  const { result, maxResultTokens } = params;
  const text = serialise(result);
  const resultTokens = estimateTokens(text);
  const resultBytes = Buffer.byteLength(text, 'utf8');
  if (maxResultTokens == null || resultTokens <= maxResultTokens) return { result, size: { resultBytes, resultTokens, truncated: false } };
  const marker: TruncatedResult = {
    truncated: true,
    note: `Result truncated to ~${maxResultTokens} tokens (was ~${resultTokens}); narrow the request or page through it.`,
    preview: text.slice(0, maxResultTokens * CHARS_PER_TOKEN),
  };
  return { result: marker, size: { resultBytes, resultTokens, truncated: true } };
}
