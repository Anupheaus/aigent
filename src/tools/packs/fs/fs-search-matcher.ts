import { compileGuardedRegex, literalPattern } from '../regex-guard.js';
import { runRegexJob } from '../regex-pool.js';

/**
 * Regex matching across one whole search: model patterns run in a worker thread (see `regex-pool.ts`), so a slow
 * pattern ends at this search's deadline instead of blocking the process. Plain-text searches compile to escaped
 * literals, which match in linear time, and run here.
 */
/** The default regex budget of one search (see `FsToolsOptions.searchBudgetMs`). */
export const SEARCH_REGEX_BUDGET_MS = 10_000;

/** One hit: index of the text searched (a line, or a name) and the 0-based column. */
export interface TextHit {
  text: number;
  column: number;
}

export type MatchOutcome = { status: 'done'; count: number; hits: TextHit[] } | { status: 'timed-out' | 'aborted' };

/** Matches every text, counting all hits and keeping the first `keep`. */
export type TextMatcher = (params: { texts: string[]; keep: number }) => Promise<MatchOutcome>;

export interface MatcherRequest {
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  signal?: AbortSignal;
  /** Wall time the whole search's regex matching may take; default `SEARCH_REGEX_BUDGET_MS`. */
  budgetMs?: number;
}

function inlineMatcher(regex: RegExp): TextMatcher {
  return async ({ texts, keep }) => {
    const hits: TextHit[] = [];
    let count = 0;
    for (const [text, value] of texts.entries()) {
      for (const found of value.matchAll(regex)) {
        // A zero-length match (e.g. `^`) is not a hit.
        if (found[0] === '') continue;
        count += 1;
        if (hits.length < keep) hits.push({ text, column: found.index ?? 0 });
      }
    }
    return { status: 'done', count, hits };
  };
}

function workerMatcher(params: { regex: RegExp; signal?: AbortSignal; budgetMs: number }): TextMatcher {
  const { regex, signal, budgetMs } = params;
  const deadline = Date.now() + budgetMs;
  return async ({ texts, keep }) => {
    const outcome = await runRegexJob({ job: { pattern: regex.source, flags: regex.flags, texts, keep, countAll: true }, deadline, ...(signal == null ? {} : { signal }) });
    if (outcome.status === 'timed-out' || outcome.status === 'aborted') return { status: outcome.status };
    // The pattern compiled here already; a worker failure (its heap cap) ends the search like the time budget.
    if (outcome.status === 'failed') return { status: 'timed-out' };
    return { status: 'done', count: outcome.count, hits: outcome.matches.map(({ text, index }) => ({ text, column: index })) };
  };
}

/** The search's matcher: the guard checks the model's own pattern, so a wrapper never hides repetition from it. */
export function createTextMatcher(request: MatcherRequest): TextMatcher {
  const { pattern, regex, caseSensitive, wholeWord, signal, budgetMs = SEARCH_REGEX_BUDGET_MS } = request;
  const guarded = compileGuardedRegex({ pattern: regex ? pattern : literalPattern(pattern), flags: caseSensitive ? 'g' : 'gi' });
  const compiled = wholeWord ? new RegExp(`\\b(?:${guarded.source})\\b`, guarded.flags) : guarded;
  return regex ? workerMatcher({ regex: compiled, budgetMs, ...(signal == null ? {} : { signal }) }) : inlineMatcher(compiled);
}
