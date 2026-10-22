import type { SolverAnswer } from '../../task-spec.js';
import { hasWord } from '../judge/code-lines.js';
import { isBuildOrVendor } from '../judge/paths.js';
import type { PolicyContext } from '../policy-types.js';
import { filesAnswer, hitPaths, LAZY_TAKE, looseness, NAIVE_READ_BATCH, orient, readTurn, scopeOf, searchTurn } from './shared.js';
import type { Style } from './shared.js';

const WIDE_MATCHES = 400;

/** The identifier's words: `cedarTierCode` → `cedar`, `tier`, `code`. */
const wordsOf = (identifier: string): string[] => identifier.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_-]+/).filter(word => word !== '');

/**
 * Mentions in any spelling. Expert: one case-insensitive regex allowing `_`/`-` between the words, build and vendored
 * files dropped. Naive: one loose search per spelling, then reading the candidates. Decoy: generated files kept.
 * Lazy: only the camelCase spelling.
 */
export async function solveAnyCase(params: { ctx: PolicyContext; identifier: string; style: Style }): Promise<SolverAnswer> {
  const { ctx, identifier, style } = params;
  const scope = scopeOf(ctx);
  const words = wordsOf(identifier);
  const regex = words.join('[_-]?');
  if (style === 'naive') {
    await orient(ctx);
    const spellings = [identifier, words.join('_'), words.join('-')];
    const views = await searchTurn({ ctx, items: spellings.map(pattern => ({ path: scope, pattern, kind: 'content', ...looseness(style), maxMatches: WIDE_MATCHES })) });
    const candidates = hitPaths(views).filter(path => !isBuildOrVendor(path));
    await readTurn({ ctx, paths: candidates, perCall: NAIVE_READ_BATCH });
    return filesAnswer(candidates);
  }
  if (style === 'lazy') {
    const views = await searchTurn({ ctx, items: [{ path: scope, pattern: identifier, kind: 'content' }] });
    return filesAnswer(hitPaths(views).slice(0, LAZY_TAKE));
  }
  const views = await searchTurn({ ctx, items: [{ path: scope, pattern: regex, regex: true, kind: 'content', maxMatches: WIDE_MATCHES, ...(style === 'decoy' ? { includeIgnored: true } : {}) }] });
  return filesAnswer(hitPaths(views).filter(path => style === 'decoy' || !isBuildOrVendor(path)));
}

/**
 * Whole-word, exact-case mentions anywhere. Expert: one whole-word, case-sensitive search. Naive: a loose search, then
 * reading every candidate and checking the word itself. Decoy: the loose search taken as is. Lazy: the first hits.
 */
export async function solveWord(params: { ctx: PolicyContext; word: string; style: Style }): Promise<SolverAnswer> {
  const { ctx, word, style } = params;
  const scope = scopeOf(ctx);
  if (style === 'naive' || style === 'decoy') {
    if (style === 'naive') await orient(ctx);
    const views = await searchTurn({ ctx, items: [{ path: scope, pattern: word, kind: 'content', ...looseness(style), maxMatches: WIDE_MATCHES }] });
    if (style === 'decoy') return filesAnswer(hitPaths(views));
    const reads = await readTurn({ ctx, paths: hitPaths(views).filter(path => !isBuildOrVendor(path)), perCall: NAIVE_READ_BATCH });
    return filesAnswer(reads.filter(({ text }) => hasWord({ text, word })).map(({ path }) => path));
  }
  const views = await searchTurn({ ctx, items: [{ path: scope, pattern: word, kind: 'content', wholeWord: true, caseSensitive: true, maxMatches: style === 'lazy' ? LAZY_TAKE : WIDE_MATCHES }] });
  const found = hitPaths(views).filter(path => !isBuildOrVendor(path));
  return filesAnswer(style === 'lazy' ? found.slice(0, LAZY_TAKE) : found);
}
