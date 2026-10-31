import { tokenize } from '../knowledge/tokenize.js';

/**
 * Words too common to tell one memory or task from another. Without this, "the" alone would make every memory look
 * related to every task.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'what', 'which', 'who', 'where', 'when', 'how', 'why', 'all', 'any', 'some',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'i', 'you', 'we', 'they', 'he', 'she', 'my', 'your', 'our', 'their',
  'me', 'us', 'them', 'please', 'find', 'show', 'get', 'not', 'no', 'so', 'if', 'then', 'there', 'here',
]);

/** The text's search terms (see `tokenize`) without stop words. */
export function contentTerms(text: string): string[] {
  return tokenize(text).filter(term => !STOP_WORDS.has(term));
}
