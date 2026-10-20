import { toolFailure } from '../tool-failure.js';
import { unsafeShape } from './regex-shape.js';

/** Longest pattern accepted from a model. */
export const MAX_PATTERN_CHARS = 1_000;
/** Flags a pattern may carry (no `y` or `d`; `g` is added where needed). */
const ALLOWED_FLAGS = /^[gimsu]*$/;
/** Back-references, which no linear engine bounds. */
const BACK_REFERENCE = /\\[1-9]|\\k</;

function rejected(params: { pattern: string; reason: string }): never {
  const { pattern, reason } = params;
  throw toolFailure({ category: 'denied', code: 'unsafe_pattern', message: `Pattern '${pattern.slice(0, 80)}' was refused: ${reason}`, suggestion: 'Use a simpler pattern without nested, alternated or adjacent repetition (or search for plain text)', details: { pattern: pattern.slice(0, MAX_PATTERN_CHARS) } });
}

/**
 * Compiles a model-supplied pattern after refusing ones whose shape backtracks catastrophically (nested or alternated
 * repetition, adjacent unbounded repetition of overlapping characters, back-references) or that are too long. This is
 * a heuristic first filter, not a bound: every model pattern is also matched in a worker thread under a hard time
 * limit (`bounded-regex.ts`). Throws a structured failure for invalid or unsafe patterns.
 */
export function compileGuardedRegex(params: { pattern: string; flags?: string }): RegExp {
  const { pattern, flags = '' } = params;
  if (pattern.length === 0) rejected({ pattern, reason: 'it is empty' });
  if (pattern.length > MAX_PATTERN_CHARS) rejected({ pattern, reason: `it is longer than ${MAX_PATTERN_CHARS} characters` });
  if (!ALLOWED_FLAGS.test(flags)) rejected({ pattern, reason: `flags must be some of g, i, m, s, u, got '${flags}'` });
  if (BACK_REFERENCE.test(pattern)) rejected({ pattern, reason: 'back-references can take exponential time' });
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, [...new Set(flags)].join(''));
  } catch (error) {
    throw toolFailure({ code: 'invalid_pattern', message: `Pattern '${pattern.slice(0, 80)}' is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`, suggestion: 'Fix the pattern, or search for plain text with regex: false' });
  }
  // Only a valid pattern is scanned, so the scanner never has to cope with broken syntax.
  const problem = unsafeShape({ pattern, flags });
  if (problem != null) rejected({ pattern, reason: problem });
  return regex;
}

/** A plain-text needle as a pattern that matches it literally. */
export function literalPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
