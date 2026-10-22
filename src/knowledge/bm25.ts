import { tokenize } from './tokenize.js';

/** Term-frequency saturation. */
const K1 = 1.2;
/** Length normalisation. */
const B = 0.75;

/** A document to score. */
export interface Bm25Document {
  id: string;
  text: string;
}

/** A keyword index over a fixed set of documents. */
export interface Bm25Index {
  /** Documents with a positive score, best first (ties by id ascending), at most `k`. */
  search(params: { query: string; k: number }): { id: string; score: number }[];
}

/** Okapi BM25 (k1 1.2, b 0.75, idf `ln(1 + (N - n + 0.5) / (n + 0.5))`) over `tokenize`d terms. */
export function createBm25(documents: Bm25Document[]): Bm25Index {
  const frequencies = documents.map(({ id, text }) => {
    const counts = new Map<string, number>();
    const terms = tokenize(text);
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    return { id, counts, length: terms.length };
  });
  const documentFrequency = new Map<string, number>();
  for (const { counts } of frequencies) for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  const averageLength = frequencies.reduce((sum, { length }) => sum + length, 0) / Math.max(1, frequencies.length);
  const total = frequencies.length;
  const idf = (term: string): number => {
    const containing = documentFrequency.get(term) ?? 0;
    return Math.log(1 + (total - containing + 0.5) / (containing + 0.5));
  };
  return {
    search: ({ query, k }) => {
      const terms = [...new Set(tokenize(query))];
      return frequencies
        .map(({ id, counts, length }) => {
          const score = terms.reduce((sum, term) => {
            const frequency = counts.get(term) ?? 0;
            if (frequency === 0) return sum;
            return sum + (idf(term) * frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * length) / (averageLength || 1)));
          }, 0);
          return { id, score };
        })
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : 1))
        .slice(0, k);
    },
  };
}
