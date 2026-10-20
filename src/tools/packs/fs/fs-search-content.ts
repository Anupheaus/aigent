import type { TextMatcher } from './fs-search-matcher.js';
import { cutLongLine } from './fs-text.js';
import { decodeExactly } from './fs-text-codec.js';
import type { SkipReason } from './fs-walk.js';

/** One match: 1-based line and column, the line's text and, when asked, the lines around it. */
export interface ContentMatch {
  line: number;
  column: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface FileMatches {
  /** Every match in the file. */
  count: number;
  /** The ones kept (at most what the caller still had room for). */
  matches: ContentMatch[];
}

export interface SearchFileParams {
  /** Reads the whole file (verified: see `fs-verify.ts`). */
  read(path: string): Promise<Uint8Array>;
  path: string;
  size: number;
  /** Larger files are skipped as `tooLarge` (and reported). */
  maxBytes: number;
  matcher: TextMatcher;
  contextLines: number;
  /** Matches still to keep in full; the rest are only counted. */
  room: number;
}

/** The file's text as fs_read shows it, or undefined when it is binary or not valid in its encoding (never searched as U+FFFD). */
function decodeWhole(params: { bytes: Uint8Array; path: string }): string | undefined {
  try {
    return decodeExactly(params).doc.text;
  } catch {
    // Binary, or invalid bytes past the binary sample: skipped as binary, like the sample would have been.
    return undefined;
  }
}

/**
 * Searches one file line by line. Every reported match comes from the file's own text (BOM dropped, CRLF as LF);
 * a file that cannot be searched is skipped with its reason rather than reported as having no matches. Returns
 * `stopped` when the search's matcher ran out of time (or was aborted).
 */
export async function searchFile(params: SearchFileParams): Promise<FileMatches | { skipped: SkipReason } | { stopped: 'timed-out' | 'aborted' }> {
  const { read, path, size, maxBytes, matcher, contextLines, room } = params;
  if (size > maxBytes) return { skipped: 'tooLarge' };
  let bytes: Uint8Array;
  try {
    bytes = await read(path);
  } catch {
    // Vanished or unreadable between the listing and the read: reported, never counted as "no matches".
    return { skipped: 'unreadable' };
  }
  const text = decodeWhole({ bytes, path });
  if (text == null) return { skipped: 'binary' };
  const lines = text.split('\n');
  const outcome = await matcher({ texts: lines, keep: room });
  if (outcome.status !== 'done') return { stopped: outcome.status };
  const matches = outcome.hits.map(({ text: index, column }): ContentMatch => {
    const context = contextLines === 0 ? {} : {
      before: lines.slice(Math.max(0, index - contextLines), index).map(around => cutLongLine(around).line),
      after: lines.slice(index + 1, index + 1 + contextLines).map(around => cutLongLine(around).line),
    };
    return { line: index + 1, column: column + 1, text: cutLongLine(lines[index] ?? '').line, ...context };
  });
  return { count: outcome.count, matches };
}
