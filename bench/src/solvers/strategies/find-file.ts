import type { SolverAnswer } from '../../task-spec.js';
import { baseName, isBuildOrVendor } from '../judge/paths.js';
import type { PolicyContext } from '../policy-types.js';
import { filesAnswer, hitPaths, LAZY_TAKE, NAIVE_READ_BATCH, orient, readTurn, scopeOf, searchTurn } from './shared.js';
import type { Style } from './shared.js';

const stemOf = (name: string): string => name.replace(/\.[^.]+$/, '');

/**
 * A file by name. Expert: one case-sensitive name search, exact base names only (none when there are none). Naive:
 * oriented listing, a loose search on the stem, then opening every candidate before deciding. Decoy: everything named
 * like it (old copies, tests, build output). Lazy: the first hit.
 */
export async function solveFindFile(params: { ctx: PolicyContext; name: string; style: Style }): Promise<SolverAnswer> {
  const { ctx, name, style } = params;
  const scope = scopeOf(ctx);
  const answer = (paths: string[]): SolverAnswer => (paths.length === 0 ? { none: true } : filesAnswer(paths));
  if (style === 'naive') {
    await orient(ctx);
    const views = await searchTurn({ ctx, items: [{ path: scope, pattern: stemOf(name), kind: 'name', includeIgnored: true }] });
    const candidates = hitPaths(views);
    await readTurn({ ctx, paths: candidates, perCall: NAIVE_READ_BATCH });
    return answer(candidates.filter(path => baseName(path) === name && !isBuildOrVendor(path)));
  }
  if (style === 'decoy' || style === 'lazy') {
    const views = await searchTurn({ ctx, items: [{ path: scope, pattern: stemOf(name), kind: 'name', includeIgnored: style === 'decoy' }] });
    // The lazy policy takes the first thing that looks right and stops.
    return answer(style === 'lazy' ? hitPaths(views).slice(0, LAZY_TAKE - 1) : hitPaths(views));
  }
  const views = await searchTurn({ ctx, items: [{ path: scope, pattern: name, kind: 'name', caseSensitive: true }] });
  return answer(hitPaths(views).filter(path => baseName(path) === name));
}
