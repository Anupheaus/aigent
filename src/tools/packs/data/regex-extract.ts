import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import { toolFailure } from '../../tool-failure.js';
import type { Tool } from '../../tool-types.js';
import { compileGuardedRegex } from '../regex-guard.js';
import { DATA_TOOL_BASE } from './data-shared.js';

export const REGEX_EXTRACT_TOOL_NAME = 'regex_extract';
/** Largest text accepted. */
export const MAX_REGEX_INPUT_CHARS = 1_000_000;
/** Text is matched in chunks of at most this many characters, cut at line breaks where possible. */
export const REGEX_CHUNK_CHARS = 200_000;
/** Matching stops (with `truncated` and `stoppedBy`) once it has taken this long; checked between chunks. */
export const REGEX_TIME_BUDGET_MS = 2_000;
const MAX_MATCHES = 1_000;
const DEFAULT_MATCHES = 100;

const regexItem = z.object({
  text: z.string().describe(`Text to search (at most ${MAX_REGEX_INPUT_CHARS} characters)`),
  pattern: z.string().min(1).describe('A regular expression (JavaScript syntax; nested or overlapping repetition and back-references are refused)'),
  flags: z.string().regex(/^[gimsu]*$/).optional().describe('Any of g, i, m, s, u (matching is always global)'),
  maxMatches: z.number().int().min(1).max(MAX_MATCHES).optional().describe(`Most matches to return (default ${DEFAULT_MATCHES})`),
}).strict();

/** Chunk ends: at the last line break before the limit (or at the limit when a line is longer). */
function chunks(text: string): { start: number; end: number }[] {
  const pieces: { start: number; end: number }[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + REGEX_CHUNK_CHARS);
    if (end < text.length) {
      const lineEnd = text.lastIndexOf('\n', end - 1);
      if (lineEnd > start) end = lineEnd + 1;
    }
    pieces.push({ start, end });
    start = end;
  }
  return pieces;
}

/**
 * `regex_extract`: matches of a guarded regular expression, with captures and named groups. Long input is matched in
 * chunks of `REGEX_CHUNK_CHARS` (a match never spans two chunks) under a `REGEX_TIME_BUDGET_MS` budget.
 */
export function createRegexExtract(): Tool {
  return defineBatchTool({
    ...DATA_TOOL_BASE,
    name: REGEX_EXTRACT_TOOL_NAME,
    description: 'Extract regular-expression matches from text: each match with its index, captures and named groups.',
    item: regexItem, contentKind: 'structured-data', fidelity: 'verbatim',
    describeActivity: ({ items }) => ({ title: items.length === 1 ? 'Extracting matches' : `Running ${items.length} extractions` }),
    runItem: async ({ text, pattern, flags = '', maxMatches = DEFAULT_MATCHES }) => {
      if (text.length > MAX_REGEX_INPUT_CHARS) throw toolFailure({ code: 'input_too_large', message: `The text has ${text.length} characters; the limit is ${MAX_REGEX_INPUT_CHARS}`, suggestion: 'Search a smaller part of the text' });
      const regex = compileGuardedRegex({ pattern, flags: `${flags}g` });
      const startedAt = performance.now();
      const matches: { match: string; index: number; captures: (string | null)[]; groups?: Record<string, string | null> }[] = [];
      let stopReason: string | undefined;
      for (const { start, end } of chunks(text)) {
        if (performance.now() - startedAt > REGEX_TIME_BUDGET_MS) { stopReason = 'time budget'; break; }
        for (const found of text.slice(start, end).matchAll(regex)) {
          if (found[0] === '') continue;
          if (matches.length >= maxMatches) { stopReason = 'maxMatches'; break; }
          const groups = found.groups == null ? undefined : Object.fromEntries(Object.entries(found.groups).map(([name, value]) => [name, value ?? null]));
          matches.push({ match: found[0], index: start + (found.index ?? 0), captures: found.slice(1).map(capture => capture ?? null), ...(groups == null ? {} : { groups }) });
        }
        if (stopReason != null) break;
      }
      return { count: matches.length, truncated: stopReason != null, ...(stopReason == null || stopReason === 'maxMatches' ? {} : { stoppedBy: stopReason }), matches };
    },
  });
}
