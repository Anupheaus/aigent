import type { FsAccess } from '../../../security/fs-access.js';
import { BINARY_SAMPLE_BYTES, cutLongLine, decoderFor, encodingOf, isBinary, normaliseText } from './fs-text.js';
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
  access: FsAccess;
  path: string;
  size: number;
  /** Larger files are skipped as `tooLarge` (and reported). */
  maxBytes: number;
  /** A global regular expression. */
  regex: RegExp;
  contextLines: number;
  /** Matches still to keep in full; the rest are only counted. */
  room: number;
}

/**
 * Searches one file line by line. Every reported match comes from the file's own text (BOM dropped, CRLF as LF);
 * a file that cannot be searched is skipped with its reason rather than reported as having no matches.
 */
export async function searchFile(params: SearchFileParams): Promise<FileMatches | { skipped: SkipReason }> {
  const { access, path, size, maxBytes, regex, contextLines, room } = params;
  if (size > maxBytes) return { skipped: 'tooLarge' };
  let bytes: Uint8Array;
  try {
    bytes = await access.readFile(path);
  } catch {
    // Vanished or unreadable between the listing and the read: reported, never counted as "no matches".
    return { skipped: 'unreadable' };
  }
  if (isBinary(bytes.subarray(0, BINARY_SAMPLE_BYTES))) return { skipped: 'binary' };
  const { text } = normaliseText(decoderFor(encodingOf(bytes).encoding).decode(bytes));
  const lines = text.split('\n');
  const matches: ContentMatch[] = [];
  let count = 0;
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(regex)) {
      // A zero-length match (e.g. `^`) is not a hit.
      if (match[0] === '') continue;
      count += 1;
      if (matches.length >= room) continue;
      const context = contextLines === 0 ? {} : {
        before: lines.slice(Math.max(0, index - contextLines), index).map(around => cutLongLine(around).line),
        after: lines.slice(index + 1, index + 1 + contextLines).map(around => cutLongLine(around).line),
      };
      matches.push({ line: index + 1, column: (match.index ?? 0) + 1, text: cutLongLine(line).line, ...context });
    }
  }
  return { count, matches };
}
