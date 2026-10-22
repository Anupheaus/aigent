import { tokenize } from './tokenize.js';

/** Longest snippet in characters. */
export const MAX_SNIPPET_CHARS = 400;
const SENTENCE = /[^.!?\n]+(?:[.!?]+|\n|$)\s*/g;

interface Sentence {
  start: number;
  end: number;
  hits: number;
}

/**
 * The part of `text` most about `query`, at most `maxChars` characters: the sentence with the most distinct query terms
 * (the earliest on a tie), widened with its neighbours while it fits. A sentence longer than the limit is cut around
 * the first query term. Text that fits is returned whole.
 */
export function snippetFor(params: { text: string; query: string; maxChars?: number }): string {
  const { text, query, maxChars = MAX_SNIPPET_CHARS } = params;
  if (text.length <= maxChars) return text.trim();
  const terms = new Set(tokenize(query));
  const sentences: Sentence[] = [...text.matchAll(SENTENCE)].map(match => {
    const start = match.index;
    return { start, end: start + match[0].length, hits: new Set(tokenize(match[0]).filter(term => terms.has(term))).size };
  });
  const best = sentences.reduce((winner, sentence) => (sentence.hits > winner.hits ? sentence : winner), sentences[0] ?? { start: 0, end: text.length, hits: 0 });
  if (best.end - best.start > maxChars) {
    const lowered = text.toLowerCase();
    const firstHit = Math.min(...[...terms].map(term => lowered.indexOf(term, best.start)).filter(at => at >= 0 && at < best.end), best.start);
    const start = Math.max(best.start, Math.min(firstHit, best.end - maxChars));
    return text.slice(start, start + maxChars).trim();
  }
  let { start, end } = best;
  const index = sentences.indexOf(best);
  for (let offset = 1; offset < sentences.length; offset += 1) {
    const next = sentences[index + offset];
    if (next != null && next.end - start <= maxChars) end = next.end;
    const previous = sentences[index - offset];
    if (previous != null && end - previous.start <= maxChars) start = previous.start;
  }
  return text.slice(start, end).trim();
}
