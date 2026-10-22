import { globRegExp } from '../../../security/glob.js';
import { createTextMatcher } from '../fs/fs-search-matcher.js';
import { isDefinitionLine } from '../fs/fs-search-rank.js';
import { toolFailure } from '../../tool-failure.js';
import type { FsDeps } from '../fs/fs-shared.js';
import { codeOnly } from './code-text.js';
import type { FileTag, IndexSnapshot } from './index-types.js';
import { readWithRetry } from './repo-index.js';

/** A query's answer, and the files it could not search now (unreadable after a retry, or grown past the read limit). */
export interface LayerAnswer {
  answer: Record<string, unknown>;
  unreadable: string[];
  tooLarge: number;
}

/** How much to return for the same query, cheapest first. */
export type AnswerLayer = 'counts' | 'files' | 'snippets' | 'full';

export interface LayerQuery {
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** `code`: only matches in code (not comments or strings; non-code files never match). */
  where: 'code' | 'any';
  layer: AnswerLayer;
  tags: FileTag[];
  excludeTags: FileTag[];
  glob?: string;
  limit: number;
  offset: number;
}

interface FileHit {
  path: string;
  count: number;
  defines: boolean;
  lines: { line: number; text: string }[];
  text: string;
}

const SNIPPETS_PER_FILE = 3;
const FULL_TEXT_CHARS = 4_000;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
/** The directory a path is grouped under in counts (its first two segments). */
const groupOf = (path: string): string => path.split('/').slice(0, -1).slice(0, 2).join('/') || '.';

/**
 * One query answered at the asked layer over the indexed files (already filtered by the ignores and the policy):
 * counts (totals grouped by directory), files (ranked: definitions first, then match count, with a `next` offset for
 * more), snippets (a few lines per file) or full text. Patterns pass the regex guard and run under the search budget.
 */
export async function answerLayer(params: { snapshot: IndexSnapshot; deps: FsDeps; query: LayerQuery; signal?: AbortSignal }): Promise<LayerAnswer> {
  const { snapshot, deps, query, signal } = params;
  const glob = query.glob == null ? undefined : globRegExp({ pattern: query.glob, caseSensitive: true });
  const separator = deps.access.platform === 'win32' ? '\\' : '/';
  const candidates: { path: string; text: string; first: number; lines: number }[] = [];
  const texts: string[] = [];
  const unreadable: string[] = [];
  let tooLarge = 0;
  for (const file of snapshot.files.values()) {
    if (query.tags.length > 0 && !query.tags.some(tag => file.tags.includes(tag))) continue;
    if (query.excludeTags.some(tag => file.tags.includes(tag)) || (glob != null && !glob.test(file.path))) continue;
    if (query.where === 'code' && !CODE_FILE.test(file.path)) continue;
    // Read now through a verified open: the file may have changed, grown or gone since the index walked it.
    const bytes = await readWithRetry({ deps, path: `${snapshot.root}${separator}${file.path.split('/').join(separator)}` });
    if (bytes == null) { unreadable.push(file.path); continue; }
    if (bytes.length > deps.policy.limits.maxReadBytes) { tooLarge += 1; continue; }
    const text = new TextDecoder().decode(bytes);
    const searched = (query.where === 'code' ? codeOnly(text) : text).split('\n');
    candidates.push({ path: file.path, text, first: texts.length, lines: searched.length });
    texts.push(...searched);
  }
  // One matcher run over every candidate line: regexes run in the guarded worker pool under the search budget.
  const outcome = await createTextMatcher({ pattern: query.pattern, regex: query.regex, caseSensitive: query.caseSensitive, wholeWord: query.wholeWord, ...(signal == null ? {} : { signal }) })({ texts, keep: Number.MAX_SAFE_INTEGER });
  if (outcome.status !== 'done') throw toolFailure({ code: 'search_stopped', message: `The search stopped (${outcome.status === 'timed-out' ? 'time budget' : 'aborted'}); use a simpler pattern`, retryable: false });
  const matchedLines = new Set(outcome.hits.map(({ text }) => text));
  const hits: FileHit[] = candidates.flatMap(({ path, text, first, lines: count }) => {
    const original = text.split('\n');
    const lines = Array.from({ length: count }, (_unused, index) => index).filter(index => matchedLines.has(first + index)).map(index => ({ line: index + 1, text: original[index] ?? '' }));
    return lines.length === 0 ? [] : [{ path, count: lines.length, defines: !query.regex && lines.some(({ text: lineText }) => isDefinitionLine({ text: lineText, name: query.pattern })), lines, text }];
  });
  hits.sort((first, second) => Number(second.defines) - Number(first.defines) || second.count - first.count || first.path.localeCompare(second.path));
  const totals = { totalMatches: hits.reduce((sum, { count }) => sum + count, 0), filesWithMatches: hits.length };
  if (query.layer === 'counts') {
    const groups = hits.reduce<Record<string, number>>((by, { path, count }) => ({ ...by, [groupOf(path)]: (by[groupOf(path)] ?? 0) + count }), {});
    return { answer: { ...totals, byDirectory: Object.fromEntries(Object.entries(groups).sort(([first], [second]) => first.localeCompare(second))) }, unreadable, tooLarge };
  }
  const page = hits.slice(query.offset, query.offset + query.limit);
  const rest = hits.slice(query.offset + query.limit);
  const more = rest.length === 0 ? {} : { more: { files: rest.length, matches: rest.reduce((sum, { count }) => sum + count, 0), next: { offset: query.offset + query.limit } } };
  const shown = page.map(({ path, count, defines, lines, text }) => ({
    path, count, ...(defines ? { defines } : {}),
    ...(query.layer === 'snippets' ? { lines: lines.slice(0, SNIPPETS_PER_FILE) } : {}),
    ...(query.layer === 'full' ? { text: text.slice(0, FULL_TEXT_CHARS), ...(text.length > FULL_TEXT_CHARS ? { cut: true } : {}) } : {}),
  }));
  return { answer: { ...totals, files: shown, ...more }, unreadable, tooLarge };
}
