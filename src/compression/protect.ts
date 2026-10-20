/** A protected span's position in the text, `end` exclusive. */
export interface ProtectedRange {
  start: number;
  end: number;
}

/**
 * Negations and exceptions: any `n't` contraction (straight or curly apostrophe) and the words that invert or
 * narrow an instruction. Their count must not change at all: dropping one inverts an instruction, and so does adding one.
 */
export const NEGATION_PATTERN = /\b(?:\w+n['’]t|not|never|no|nor|cannot|without|unless|except|avoid|none|nothing|neither|nobody)\b/gi;

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
  // Numbers, with a sign or comparison before them (not a hyphen inside a word) and a unit when one follows.
  /(?:(?<![\w])[-+±]|[<>≤≥])?\d+(?:[.,]\d+)*(?:\s?(?:%|ms|sec|min|kb|mb|gb|tb|px|rem|em|kg|km|cm|mm|s|h|g|m)(?![\w]))?/gi,
  // Limits, with the number they bound.
  /\b(?:at (?:most|least)|(?:less|more|fewer) than)\b(?:\s+[-+]?\d+(?:[.,]\d+)*)?/gi,
  // Negations, exceptions, modals and order words, whose loss silently inverts or loosens an instruction.
  NEGATION_PATTERN,
  /\b(?:must|only|shall|before|after)\b/gi,
];

function matchesOf(params: { text: string; pattern: RegExp }): ProtectedRange[] {
  const { text, pattern } = params;
  return [...text.matchAll(pattern)].map(match => ({ start: match.index, end: match.index + match[0].length }));
}

/** Every occurrence of each `forceKeep` entry, as ranges. */
function forcedRanges(params: { text: string; forceKeep: readonly string[] }): ProtectedRange[] {
  const { text, forceKeep } = params;
  return forceKeep.filter(entry => entry !== '').flatMap(entry => {
    const ranges: ProtectedRange[] = [];
    for (let start = text.indexOf(entry); start !== -1; start = text.indexOf(entry, start + 1)) ranges.push({ start, end: start + entry.length });
    return ranges;
  });
}

/** Every protected range of `text` (and every `forceKeep` occurrence), overlapping matches merged, in text order. */
export function findProtectedRanges(text: string, forceKeep: readonly string[] = []): ProtectedRange[] {
  const ranges = [...PROTECTED_PATTERNS.flatMap(pattern => matchesOf({ text, pattern })), ...forcedRanges({ text, forceKeep })].sort((left, right) => left.start - right.start || right.end - left.end);
  return ranges.reduce<ProtectedRange[]>((merged, range) => {
    const last = merged.at(-1);
    if (last == null || range.start >= last.end) return [...merged, range];
    return [...merged.slice(0, -1), { start: last.start, end: Math.max(last.end, range.end) }];
  }, []);
}

/**
 * The spans compression must keep byte-identical: negations, exceptions, limits and modals, signed numbers with units, file paths,
 * identifiers, quoted strings, URLs, code spans and fenced blocks, JSON objects and directive lines. In text order.
 */
export function findProtectedSpans(text: string, forceKeep: readonly string[] = []): string[] {
  return findProtectedRanges(text, forceKeep).map(({ start, end }) => text.slice(start, end));
}
