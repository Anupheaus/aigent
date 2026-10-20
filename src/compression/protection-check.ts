import { findProtectedSpans, NEGATION_PATTERN } from './protect.js';

/**
 * Bump whenever the protection rules change, so cached compressions accepted under older (looser) rules are not
 * served as if they had passed the current ones. Part of every compression cache key.
 */
export const PROTECTION_VERSION = 2;

export interface ProtectionCheckParams {
  text: string;
  output: string;
  forceKeep: readonly string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches whole occurrences of `span`: one that starts or ends with a word character must not touch another. */
function spanPattern(span: string): RegExp {
  const before = /^\w/.test(span) ? '(?<!\\w)' : '';
  const after = /\w$/.test(span) ? '(?!\\w)' : '';
  return new RegExp(`${before}${escapeRegExp(span)}${after}`, 'g');
}

/** Every protected span occurs in the output in source order (as a subsequence), so none was dropped or swapped. */
function keepsSpansInOrder(params: { spans: readonly string[]; output: string }): boolean {
  const { spans, output } = params;
  let cursor = 0;
  for (const span of spans) {
    const pattern = spanPattern(span);
    pattern.lastIndex = cursor;
    const match = pattern.exec(output);
    if (match == null) return false;
    cursor = match.index + match[0].length;
  }
  return true;
}

/** How often each negation occurs, apostrophes normalised so `don’t` and `don't` count as one word. */
function negationCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [word] of text.matchAll(NEGATION_PATTERN)) {
    const key = word.toLowerCase().replace('’', '\'');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The output has exactly the source's negations: none dropped and none added. */
function keepsNegations(params: { text: string; output: string }): boolean {
  const { text, output } = params;
  const [source, compressed] = [negationCounts(text), negationCounts(output)];
  return source.size === compressed.size && [...source].every(([word, count]) => compressed.get(word) === count);
}

/**
 * Whether compressed `output` may stand in for `text`: every protected span (and `forceKeep` entry) appears in it, as
 * a whole word, in source order, and its negations are exactly the source's. Rejects dropped spans, reordered spans
 * (swapped paths or numbers) and inserted or removed negations.
 */
export function keepsProtected(params: ProtectionCheckParams): boolean {
  const { text, output, forceKeep } = params;
  return keepsNegations({ text, output }) && keepsSpansInOrder({ spans: findProtectedSpans(text, forceKeep), output });
}
