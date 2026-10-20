import { canonicalJson } from '../core/canonical-json.js';

/** Characters of canonical argument JSON kept on each trace step. */
export const ARGS_SUMMARY_LENGTH = 120;

export interface SummariseArgsParams {
  args: unknown;
  /** False keeps only the arguments' shape: keys and value types, never values. */
  captureContent: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The same structure with every leaf value replaced by its type, e.g. `{ "path": "<string>" }`. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, shapeOf(field)]));
  return value === null ? null : `<${typeof value}>`;
}

/** First `ARGS_SUMMARY_LENGTH` characters of the arguments' canonical JSON (or of their shape when content capture is off). */
export function summariseArgs(params: SummariseArgsParams): string {
  const { args, captureContent } = params;
  const text = canonicalJson(captureContent ? args : shapeOf(args)) ?? '';
  return text.slice(0, ARGS_SUMMARY_LENGTH);
}
