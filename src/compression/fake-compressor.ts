import type { Compressor, CompressorInput } from './compressor-types.js';

/** Removes every second droppable word unless told otherwise. */
const DEFAULT_DROP_EVERY = 2;
const FAKE_COMPRESSOR_ID = 'fake';
const BROKEN_COMPRESSOR_ID = 'broken';
const FAKE_VERSION = '1';
/** Negations a careless compressor drops, for testing the rejection path. */
const NEGATIONS = /\b(?:not|never|no|don't|cannot)\b\s?/gi;

export interface FakeCompressorOptions {
  /** Drops every Nth word that is not protected (default 2). */
  dropEvery?: number;
  /** Part of the cache key; change it to simulate a new compressor release. */
  version?: string;
}

interface Range {
  start: number;
  end: number;
}

/** Every occurrence of every protected string, as character ranges. */
function protectedRanges(params: { text: string; protect: string[] }): Range[] {
  const { text, protect } = params;
  return protect.filter(span => span !== '').flatMap(span => {
    const ranges: Range[] = [];
    for (let start = text.indexOf(span); start !== -1; start = text.indexOf(span, start + 1)) ranges.push({ start, end: start + span.length });
    return ranges;
  });
}

/** The text with every Nth unprotected word (and the whitespace after it) cut out; everything else byte for byte. */
function dropWords(params: { input: CompressorInput; dropEvery: number }): string {
  const { input: { text, protect }, dropEvery } = params;
  const ranges = protectedRanges({ text, protect });
  const isProtected = ({ start, end }: Range): boolean => ranges.some(range => start < range.end && end > range.start);
  let droppable = 0;
  let kept = '';
  let cursor = 0;
  for (const match of text.matchAll(/\S+\s*/g)) {
    const word = { start: match.index, end: match.index + match[0].trimEnd().length };
    if (isProtected(word)) continue;
    droppable += 1;
    if (droppable % dropEvery !== 0) continue;
    kept += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  return kept + text.slice(cursor);
}

/**
 * A deterministic test compressor: removes every Nth word that does not overlap a protected span, leaving all other
 * bytes untouched. `targetRatio` is ignored. Never ships to production; it exists so compression can be tested
 * without a model.
 */
export function fakeCompressor(options: FakeCompressorOptions = {}): Compressor {
  const { dropEvery = DEFAULT_DROP_EVERY, version = FAKE_VERSION } = options;
  return { id: FAKE_COMPRESSOR_ID, version, compress: async input => ({ text: dropWords({ input, dropEvery }) }) };
}

/** A compressor that ignores the protect list and drops negations, so tests can see its output rejected. */
export function createBrokenCompressor(): Compressor {
  return { id: BROKEN_COMPRESSOR_ID, version: FAKE_VERSION, compress: async ({ text }) => ({ text: text.replace(NEGATIONS, '') }) };
}
