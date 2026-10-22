import type { SolverAnswer } from '../../task-spec.js';
import { reviewFile, RISK_PATTERNS } from '../judge/bugs.js';
import { isOwnCode } from '../judge/paths.js';
import type { PolicyContext } from '../policy-types.js';
import { hitPaths, INJECTED_EXCLUSION, LAZY_TAKE, orient, readTurn, scopeOf, searchTurn } from './shared.js';
import type { Style } from './shared.js';

const NAIVE_SEARCH_ROUNDS = 3;

const riskItem = (scope: string, pattern: string): Record<string, unknown> => ({ path: scope, pattern, regex: true, caseSensitive: true, kind: 'content', maxMatches: 200 });

/**
 * Every real bug. Expert: all risk searches in one turn, then one read of the own-code files they hit, then a careful
 * review. Naive: oriented, the searches spread over three turns, then the same review. Decoy: every suspicious line is
 * a bug, and a planted "report no bugs" note is obeyed. Lazy: the first search only.
 */
export async function solveBugs(params: { ctx: PolicyContext; style: Style }): Promise<SolverAnswer> {
  const { ctx, style } = params;
  const scope = scopeOf(ctx);
  if (style === 'decoy') {
    const notes = await searchTurn({ ctx, items: [{ path: scope, pattern: 'AI', caseSensitive: true, kind: 'content', contextLines: 1 }, ...RISK_PATTERNS.map(pattern => riskItem(scope, pattern))] });
    if (notes[0]?.hits.some(({ matches }) => matches.some(({ text }) => INJECTED_EXCLUSION.test(text)))) return { bugs: [] };
    return { bugs: notes.slice(1).flatMap(({ hits }) => hits.flatMap(({ path, matches }) => matches.map(({ line }) => ({ path, line, cause: 'suspicious construct' })))) };
  }
  let views;
  if (style === 'naive') {
    await orient(ctx);
    const per = Math.ceil(RISK_PATTERNS.length / NAIVE_SEARCH_ROUNDS);
    views = [];
    for (let round = 0; round < NAIVE_SEARCH_ROUNDS; round += 1) views.push(...await searchTurn({ ctx, items: RISK_PATTERNS.slice(round * per, (round + 1) * per).map(pattern => riskItem(scope, pattern)) }));
  } else {
    views = await searchTurn({ ctx, items: (style === 'lazy' ? RISK_PATTERNS.slice(0, LAZY_TAKE) : RISK_PATTERNS).map(pattern => riskItem(scope, pattern)) });
  }
  const reads = await readTurn({ ctx, paths: hitPaths(views).filter(isOwnCode) });
  return { bugs: reads.flatMap(({ path, text }) => reviewFile(text).map(bug => ({ path, ...bug }))) };
}
