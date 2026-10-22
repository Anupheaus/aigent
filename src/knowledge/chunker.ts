import { createAigentError } from '../core/aigent-error.js';
import { findBoundaries, kindOf, NO_BREAK, sectionAt, STRUCTURE } from './chunk-boundaries.js';
import type { Boundaries } from './chunk-boundaries.js';
import type { ChunkPiece, Chunker } from './knowledge-types.js';

/** Default chunk size in characters. */
export const DEFAULT_TARGET_CHARS = 800;
/** Default characters a chunk repeats from the end of the previous one. */
export const DEFAULT_OVERLAP_CHARS = 100;
/** A chunk is never cut shorter than this share of the target to reach a better break. */
const MIN_CHUNK_SHARE = 0.25;
/** Fenced blocks up to this many targets stay whole. */
const FENCE_TARGETS = 2;
const NON_WHITESPACE = /\S/;

/** `createChunker(options)`. */
export interface ChunkerOptions {
  /** Default 800. */
  targetChars?: number;
  /** Default 100; less than the target. */
  overlapChars?: number;
}

function firstNonWhitespace(params: { text: string; from: number }): number {
  const { text, from } = params;
  for (let at = from; at < text.length; at += 1) if (NON_WHITESPACE.test(text[at] ?? '')) return at;
  return text.length;
}

function trimmedEnd(params: { text: string; start: number; end: number }): number {
  const { text, start } = params;
  let { end } = params;
  while (end > start && !NON_WHITESPACE.test(text[end - 1] ?? '')) end -= 1;
  return end;
}

/** Where the chunk starting at `start` ends: the strongest (then latest) break near the target, else the first allowed one, else a hard cut. */
function chooseEnd(params: { boundaries: Boundaries; start: number; target: number; length: number }): number {
  const { boundaries: { strength }, start, target, length } = params;
  if (length - start <= target) return length;
  const low = start + Math.ceil(target * MIN_CHUNK_SHARE);
  const high = start + target;
  let best = NO_BREAK;
  let bestAt = -1;
  for (let at = low; at <= high; at += 1) {
    const value = strength[at] ?? NO_BREAK;
    if (value !== NO_BREAK && value >= best) {
      best = value;
      bestAt = at;
    }
  }
  if (bestAt > 0) return bestAt;
  // No allowed break near the target (a fenced block, or one long word): the first one after it.
  for (let at = high + 1; at <= Math.min(length, start + target * FENCE_TARGETS + target); at += 1) if ((strength[at] ?? NO_BREAK) !== NO_BREAK) return at;
  return high;
}

/** Where the next chunk starts: the first allowed break at most `overlap` before `end`, or `end` after a structural break. */
function nextStart(params: { boundaries: Boundaries; start: number; end: number; overlap: number }): number {
  const { boundaries: { strength }, start, end, overlap } = params;
  if ((strength[end] ?? NO_BREAK) >= STRUCTURE) return end;
  for (let at = Math.max(start + 1, end - overlap); at < end; at += 1) if ((strength[at] ?? NO_BREAK) !== NO_BREAK) return at;
  return end;
}

/** 1-based line of a character offset. */
function lineOf(params: { lineStarts: number[]; at: number }): number {
  const { lineStarts, at } = params;
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= at) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  return starts;
}

/**
 * A chunker by file kind (from the URI's extension): markdown splits at headings (whose path becomes `section`
 * metadata), then paragraphs and sentences, and never inside a fenced block of up to twice the target; code splits at
 * top-level declarations, then blank lines; text at paragraphs, then sentences. Chunks repeat up to `overlapChars` of
 * the previous chunk, except after a heading or declaration. Spans are trimmed of surrounding whitespace.
 */
export function createChunker(options: ChunkerOptions = {}): Chunker {
  const { targetChars = DEFAULT_TARGET_CHARS, overlapChars = DEFAULT_OVERLAP_CHARS } = options;
  if (!Number.isSafeInteger(targetChars) || targetChars < 2) throw createAigentError({ code: 'invalid_definition', message: `createChunker: targetChars must be an integer of at least 2, got ${String(targetChars)}` });
  if (!Number.isSafeInteger(overlapChars) || overlapChars < 0 || overlapChars >= targetChars) throw createAigentError({ code: 'invalid_definition', message: `createChunker: overlapChars must be an integer from 0 to below targetChars (${targetChars}), got ${String(overlapChars)}` });
  return ({ text, uri }) => {
    const kind = kindOf(uri);
    const boundaries = findBoundaries({ text, kind, maxFence: targetChars * FENCE_TARGETS });
    const lineStarts = lineStartsOf(text);
    const pieces: ChunkPiece[] = [];
    let start = firstNonWhitespace({ text, from: 0 });
    while (start < text.length) {
      const rawEnd = chooseEnd({ boundaries, start, target: targetChars, length: text.length });
      const end = trimmedEnd({ text, start, end: rawEnd });
      const section = kind === 'markdown' ? sectionAt({ headings: boundaries.headings, at: start }) : undefined;
      pieces.push({ start, end, startLine: lineOf({ lineStarts, at: start }), endLine: lineOf({ lineStarts, at: end - 1 }), metadata: { kind, ...(section == null ? {} : { section }) } });
      if (rawEnd >= text.length) break;
      start = firstNonWhitespace({ text, from: nextStart({ boundaries, start, end: rawEnd, overlap: overlapChars }) });
    }
    return pieces;
  };
}
