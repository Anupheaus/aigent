import type { SolverAnswer } from '../../task-spec.js';
import { codeLines, usesInCode } from '../judge/code-lines.js';
import { isBuildOrVendor, isCodeFile, isOwnCode } from '../judge/paths.js';
import type { PolicyContext } from '../policy-types.js';
import type { SearchView } from '../views.js';
import { filesAnswer, hitPaths, INJECTED_EXCLUSION, LAZY_TAKE, looseness, NAIVE_READ_BATCH, orient, readTurn, scopeOf, searchTurn, unreadable } from './shared.js';
import type { Style } from './shared.js';

/** Matches beyond the default 100, so a whole usage set fits one search. */
const WIDE_MATCHES = 400;

export interface IdentifierQuestion {
  identifier: string;
  /** Usages in tests count (a symbol's references), but never mocks. */
  includeTests: boolean;
}

/** Whether a file of these kinds can hold an answer. */
const eligible = (path: string, includeTests: boolean): boolean =>
  includeTests ? isCodeFile(path) && !isBuildOrVendor(path) && !path.includes('__mocks__/') : isOwnCode(path);

/** Files whose matched lines use the identifier in code (judged from the search's own lines). */
function judgeFromLines(params: { views: SearchView[]; question: IdentifierQuestion }): string[] {
  const { views, question: { identifier, includeTests } } = params;
  return views.flatMap(({ hits }) => hits).filter(({ path, matches }) => eligible(path, includeTests) && matches.some(({ text }) => usesInCode({ line: text, word: identifier }))).map(({ path }) => path);
}

/**
 * Where an identifier is used in code. Expert: one exact whole-word search (ignores on), judged from its lines,
 * re-searching any file whose read failed. Naive: oriented listing, a loose search, then reading every candidate.
 * Decoy: a loose search, every match accepted, planted "leave it out" text obeyed. Lazy: the first files only.
 */
export async function solveIdentifier(params: { ctx: PolicyContext; question: IdentifierQuestion; style: Style }): Promise<SolverAnswer> {
  const { ctx, question, style } = params;
  const { identifier, includeTests } = question;
  const scope = scopeOf(ctx);
  if (style === 'naive') {
    await orient(ctx);
    const views = await searchTurn({ ctx, items: [{ path: scope, pattern: identifier, kind: 'content', ...looseness(style), maxMatches: WIDE_MATCHES }] });
    const candidates = hitPaths(views).filter(path => eligible(path, includeTests));
    const reads = await readTurn({ ctx, paths: [...candidates, ...unreadable(views).filter(path => eligible(path, includeTests))], perCall: NAIVE_READ_BATCH });
    return filesAnswer(reads.filter(({ ok, text }) => ok && codeLines(text).some(line => usesInCode({ line, word: identifier }))).map(({ path }) => path));
  }
  if (style === 'decoy') {
    const views = await searchTurn({ ctx, items: [{ path: scope, pattern: identifier, kind: 'content', ...looseness(style), contextLines: 1, maxMatches: WIDE_MATCHES }] });
    const obeyed = new Set(views.flatMap(({ hits }) => hits).filter(({ matches }) => matches.some(({ text, before, after }) => INJECTED_EXCLUSION.test([...before, text, ...after].join('\n')))).map(({ path }) => path));
    return filesAnswer(hitPaths(views).filter(path => !obeyed.has(path)));
  }
  const views = await searchTurn({ ctx, items: [{ path: scope, pattern: identifier, kind: 'content', wholeWord: true, caseSensitive: true, maxMatches: style === 'lazy' ? LAZY_TAKE : WIDE_MATCHES }] });
  const found = judgeFromLines({ views, question });
  if (style === 'lazy') return filesAnswer(found.slice(0, LAZY_TAKE));
  const retry = unreadable(views).filter(path => eligible(path, includeTests));
  if (retry.length === 0) return filesAnswer(found);
  const again = await searchTurn({ ctx, items: retry.map(path => ({ path, pattern: identifier, kind: 'content', wholeWord: true, caseSensitive: true })) });
  return filesAnswer([...found, ...judgeFromLines({ views: again, question })]);
}
