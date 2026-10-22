import { tokenize } from './tokenize.js';
import { cosine } from './vector-math.js';

/** Chunks this similar (Jaccard of word shingles) are near duplicates: only the better-ranked one is kept. */
export const NEAR_DUPLICATE_JACCARD = 0.9;
/** Words per shingle. */
const SHINGLE_WORDS = 3;

/** A ranked candidate for diversity selection. */
export interface DiversityCandidate {
  chunkId: string;
  score: number;
  text: string;
  vector?: number[];
}

function shingles(text: string): Set<string> {
  const words = tokenize(text);
  if (words.length < SHINGLE_WORDS) return new Set([words.join(' ')]);
  const set = new Set<string>();
  for (let at = 0; at + SHINGLE_WORDS <= words.length; at += 1) set.add(words.slice(at, at + SHINGLE_WORDS).join(' '));
  return set;
}

/** Jaccard similarity of two texts' word shingles. */
export function shingleJaccard(left: string, right: string): number {
  return setJaccard(shingles(left), shingles(right));
}

function setJaccard(one: Set<string>, other: Set<string>): number {
  let shared = 0;
  for (const shingle of one) if (other.has(shingle)) shared += 1;
  const union = one.size + other.size - shared;
  return union === 0 ? 1 : shared / union;
}

/** The candidates (in rank order) without near duplicates of a better-ranked one. */
export function collapseNearDuplicates<T extends DiversityCandidate>(candidates: T[]): T[] {
  const kept: { candidate: T; set: Set<string> }[] = [];
  for (const candidate of candidates) {
    const set = shingles(candidate.text);
    if (!kept.some(other => setJaccard(other.set, set) >= NEAR_DUPLICATE_JACCARD)) kept.push({ candidate, set });
  }
  return kept.map(({ candidate }) => candidate);
}

/**
 * Maximal marginal relevance: repeatedly picks the candidate with the best `lambda * relevance - (1 - lambda) *
 * similarity to the picked ones` (relevance is the score scaled to 0..1; similarity is cosine of vectors, or shingle
 * Jaccard without them). Ties go to the earlier-ranked candidate, so the result is deterministic.
 */
export function mmrSelect<T extends DiversityCandidate>(params: { candidates: T[]; k: number; lambda: number }): T[] {
  const { candidates, k, lambda } = params;
  const top = Math.max(...candidates.map(({ score }) => score), 0);
  const relevance = (candidate: T): number => (top === 0 ? 0 : candidate.score / top);
  const similarity = (left: T, right: T): number => (left.vector != null && right.vector != null ? cosine(left.vector, right.vector) : shingleJaccard(left.text, right.text));
  const picked: T[] = [];
  const remaining = [...candidates];
  while (picked.length < k && remaining.length > 0) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    remaining.forEach((candidate, index) => {
      const redundancy = Math.max(0, ...picked.map(chosen => similarity(candidate, chosen)));
      const value = lambda * relevance(candidate) - (1 - lambda) * redundancy;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    });
    picked.push(...remaining.splice(bestIndex, 1));
  }
  return picked;
}
