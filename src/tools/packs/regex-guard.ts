import { toolFailure } from '../tool-failure.js';

/** Longest pattern accepted from a model. */
export const MAX_PATTERN_CHARS = 1_000;
/** Flags a pattern may carry (no `y` or `d`; `g` is added where needed). */
const ALLOWED_FLAGS = /^[gimsu]*$/;

/**
 * Patterns known to backtrack exponentially (ReDoS): a quantified group that itself holds a quantifier, such as
 * `(a+)+`, `(a*)*`, `(\w+\s?)*` or `(a|aa)+`, and back-references, which no linear engine bounds.
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/;
/** A repeated group of alternatives, e.g. `(a|aa)+`: its body is checked for alternatives that overlap. */
const REPEATED_ALTERNATION = /\(((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*)\)\s*(?:[+*]|\{\d+,\d*\})/g;
const BACK_REFERENCE = /\\[1-9]|\\k</;
/** Alternatives that are not plain text (wildcards, classes, escapes) may overlap in ways a prefix test cannot see. */
const NON_LITERAL = /[.\\[]/;

/** Alternatives where one is a prefix of another (`a|aa`), or that are not plain text, let a repeat split text many ways. */
function hasOverlappingAlternatives(pattern: string): boolean {
  for (const [, body = ''] of pattern.matchAll(REPEATED_ALTERNATION)) {
    const alternatives = body.replace(/^\?:/, '').split(/(?<!\\)\|/);
    if (alternatives.some(alternative => alternative === '' || NON_LITERAL.test(alternative))) return true;
    if (alternatives.some((alternative, index) => alternatives.some((other, otherIndex) => otherIndex !== index && other.startsWith(alternative)))) return true;
  }
  return false;
}

function rejected(params: { pattern: string; reason: string }): never {
  const { pattern, reason } = params;
  throw toolFailure({ category: 'denied', code: 'unsafe_pattern', message: `Pattern '${pattern.slice(0, 80)}' was refused: ${reason}`, suggestion: 'Use a simpler pattern without nested or alternated repetition (or search for plain text)', details: { pattern: pattern.slice(0, MAX_PATTERN_CHARS) } });
}

/**
 * Compiles a model-supplied pattern after refusing ones that can backtrack catastrophically (nested or alternated
 * repetition, back-references) or are too long. This is a heuristic guard: callers also bound the input they match
 * against (see `regex_extract`). Throws a structured failure for invalid or unsafe patterns.
 */
export function compileGuardedRegex(params: { pattern: string; flags?: string }): RegExp {
  const { pattern, flags = '' } = params;
  if (pattern.length === 0) rejected({ pattern, reason: 'it is empty' });
  if (pattern.length > MAX_PATTERN_CHARS) rejected({ pattern, reason: `it is longer than ${MAX_PATTERN_CHARS} characters` });
  if (!ALLOWED_FLAGS.test(flags)) rejected({ pattern, reason: `flags must be some of g, i, m, s, u, got '${flags}'` });
  if (NESTED_QUANTIFIER.test(pattern) || hasOverlappingAlternatives(pattern)) rejected({ pattern, reason: 'it repeats a group that itself repeats or alternates, which can take exponential time' });
  if (BACK_REFERENCE.test(pattern)) rejected({ pattern, reason: 'back-references can take exponential time' });
  try {
    return new RegExp(pattern, [...new Set(flags)].join(''));
  } catch (error) {
    throw toolFailure({ code: 'invalid_pattern', message: `Pattern '${pattern.slice(0, 80)}' is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`, suggestion: 'Fix the pattern, or search for plain text with regex: false' });
  }
}

/** A plain-text needle as a pattern that matches it literally. */
export function literalPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
