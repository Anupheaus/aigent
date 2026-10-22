const WORD = /[\p{L}\p{N}_]+/gu;
const PART = /[\p{Lu}]?[\p{Ll}\p{N}]+|[\p{Lu}]+(?![\p{Ll}])/gu;

/**
 * Search terms of a text: each word lower-cased, and for identifiers (`parseConfigFile`, `max_retry_count`) also
 * their parts, so a query for the whole identifier and one for its words both match.
 */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  for (const [word] of text.matchAll(WORD)) {
    terms.push(word.toLowerCase());
    const parts = word.split('_').flatMap(piece => [...piece.matchAll(PART)].map(([part]) => part.toLowerCase()));
    if (parts.length > 1) terms.push(...parts);
  }
  return terms;
}
