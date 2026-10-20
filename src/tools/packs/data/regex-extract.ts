import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import { toolFailure } from '../../tool-failure.js';
import type { Tool } from '../../tool-types.js';
import { compileGuardedRegex } from '../regex-guard.js';
import { runRegexJob } from '../regex-pool.js';
import { DATA_TOOL_BASE } from './data-shared.js';

export const REGEX_EXTRACT_TOOL_NAME = 'regex_extract';
/** Largest text accepted. */
export const MAX_REGEX_INPUT_CHARS = 1_000_000;
/** Text is matched in chunks of at most this many characters, cut at line breaks where possible. */
export const REGEX_CHUNK_CHARS = 200_000;
/**
 * Matching stops (with `truncated` and `stoppedBy`) once it has taken this long. Matching runs in a worker thread
 * that is terminated at the deadline, so even a catastrophic pattern cannot block the process past it.
 */
export const REGEX_TIME_BUDGET_MS = 2_000;
const MAX_MATCHES = 1_000;
const DEFAULT_MATCHES = 100;

const regexItem = z.object({
  text: z.string().describe(`Text to search (at most ${MAX_REGEX_INPUT_CHARS} characters)`),
  pattern: z.string().min(1).describe('A regular expression (JavaScript syntax; nested or overlapping repetition and back-references are refused)'),
  flags: z.string().regex(/^[gimsu]*$/).optional().describe('Any of g, i, m, s, u (matching is always global)'),
  maxMatches: z.number().int().min(1).max(MAX_MATCHES).optional().describe(`Most matches to return (default ${DEFAULT_MATCHES})`),
}).strict();

type Extracted = { match: string; index: number; captures: (string | null)[]; groups?: Record<string, string | null> };

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
 * chunks of `REGEX_CHUNK_CHARS` (a match never spans two chunks) in a worker thread under a `REGEX_TIME_BUDGET_MS`
 * deadline; matches found before the deadline are kept.
 */
export function createRegexExtract(): Tool {
  return defineBatchTool({
    ...DATA_TOOL_BASE,
    name: REGEX_EXTRACT_TOOL_NAME,
    description: 'Extract regular-expression matches from text: each match with its index, captures and named groups.',
    item: regexItem, contentKind: 'structured-data', fidelity: 'verbatim',
    describeActivity: ({ items }) => ({ title: items.length === 1 ? 'Extracting matches' : `Running ${items.length} extractions` }),
    runItem: async ({ text, pattern, flags = '', maxMatches = DEFAULT_MATCHES }, { signal }) => {
      if (text.length > MAX_REGEX_INPUT_CHARS) throw toolFailure({ code: 'input_too_large', message: `The text has ${text.length} characters; the limit is ${MAX_REGEX_INPUT_CHARS}`, suggestion: 'Search a smaller part of the text' });
      const regex = compileGuardedRegex({ pattern, flags: `${flags}g` });
      const deadline = Date.now() + REGEX_TIME_BUDGET_MS;
      const matches: Extracted[] = [];
      let stopReason: string | undefined;
      for (const { start, end } of chunks(text)) {
        const outcome = await runRegexJob({ job: { pattern: regex.source, flags: regex.flags, texts: [text.slice(start, end)], keep: maxMatches - matches.length, countAll: false }, deadline, signal });
        if (outcome.status === 'timed-out') { stopReason = 'time budget'; break; }
        if (outcome.status === 'aborted') { stopReason = 'aborted'; break; }
        if (outcome.status === 'failed') throw toolFailure({ code: 'regex_failed', message: `Pattern '${pattern.slice(0, 80)}' failed while matching: ${outcome.message}`, suggestion: 'Use a simpler pattern' });
        for (const { match, index, captures, groups } of outcome.matches) matches.push({ match, index: start + index, captures, ...(groups == null ? {} : { groups }) });
        if (!outcome.isComplete) { stopReason = 'maxMatches'; break; }
      }
      return { count: matches.length, truncated: stopReason != null, ...(stopReason == null || stopReason === 'maxMatches' ? {} : { stoppedBy: stopReason }), matches };
    },
  });
}
