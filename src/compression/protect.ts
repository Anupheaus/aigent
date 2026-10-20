/** A protected span's position in the text, `end` exclusive. */
export interface ProtectedRange {
  start: number;
  end: number;
}

/**
 * What compression must never drop. Order does not matter: overlapping matches are merged into the outermost span.
 */
const PROTECTED_PATTERNS: readonly RegExp[] = [
  // Fenced code blocks and inline code spans.
  /```[\s\S]*?```/g,
  /`[^`\n]+`/g,
  // The library's own directive lines.
  /^::aigent .*$/gm,
  // URLs, without trailing punctuation.
  /\bhttps?:\/\/[^\s"'<>)\]]*[^\s"'<>)\].,;:!?]/g,
  // Flat JSON objects with at least one quoted key.
  /\{[^{}\n]*"[^"\n]*"\s*:[^{}]*\}/g,
  // Quoted strings: double quotes, and single quotes that are not apostrophes.
  /"[^"\n]+"/g,
  /(?<![\w])'[^'\n]+'(?![\w])/g,
  // File paths with at least one separator (POSIX, relative, home or Windows), without trailing punctuation.
  /(?:[A-Za-z]:\\|~\/|\.{1,2}\/|\/)?(?:[\w.-]+[\\/])+[\w.-]*[\w-]/g,
  // Identifiers: camelCase, PascalCase with two or more humps, snake_case and SCREAMING_CASE.
  /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g,
  /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g,
  /\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b/g,
  // Numbers, with a unit when one follows.
  /\d+(?:[.,]\d+)*(?:\s?(?:%|ms|sec|min|kb|mb|gb|tb|px|rem|em|kg|km|cm|mm|s|h|g|m)(?![\w]))?/gi,
  // Negations and modals, whose loss silently inverts an instruction.
  /\b(?:not|never|no|must|only|don't|shall|cannot|can't|won't|mustn't|shouldn't|isn't|doesn't|didn't|nor|without)\b/gi,
];

function matchesOf(params: { text: string; pattern: RegExp }): ProtectedRange[] {
  const { text, pattern } = params;
  return [...text.matchAll(pattern)].map(match => ({ start: match.index, end: match.index + match[0].length }));
}

/** Every protected range of `text`, overlapping matches merged, in text order. */
export function findProtectedRanges(text: string): ProtectedRange[] {
  const ranges = PROTECTED_PATTERNS.flatMap(pattern => matchesOf({ text, pattern })).sort((left, right) => left.start - right.start || right.end - left.end);
  return ranges.reduce<ProtectedRange[]>((merged, range) => {
    const last = merged.at(-1);
    if (last == null || range.start >= last.end) return [...merged, range];
    return [...merged.slice(0, -1), { start: last.start, end: Math.max(last.end, range.end) }];
  }, []);
}

/**
 * The spans compression must keep byte-identical: negations and modals, numbers with units, file paths,
 * identifiers, quoted strings, URLs, code spans and fenced blocks, JSON objects and directive lines. In text order.
 */
export function findProtectedSpans(text: string): string[] {
  return findProtectedRanges(text).map(({ start, end }) => text.slice(start, end));
}
