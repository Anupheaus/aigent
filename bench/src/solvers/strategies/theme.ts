import type { SolverAnswer } from '../../task-spec.js';
import { isOwnCode } from '../judge/paths.js';
import type { PolicyContext } from '../policy-types.js';
import type { SearchView } from '../views.js';
import { filesAnswer, hitPaths, LAZY_TAKE, NAIVE_READ_BATCH, orient, readTurn, scopeOf, searchTurn } from './shared.js';
import type { Style } from './shared.js';

const DEFINITION_PATTERNS = ['createTheme\\(', ':\\s*\\w+Tokens\\s*='];
const EXPORTED_NAME = /export\s+const\s+(\w+)/;

/** Own-code definitions found by the definition searches, with the name each exports. */
function definitions(views: SearchView[]): { path: string; name: string }[] {
  return views.flatMap(({ hits }) => hits).filter(({ path }) => isOwnCode(path)).flatMap(({ path, matches }) => {
    const name = matches.map(({ text }) => EXPORTED_NAME.exec(text)?.[1]).find(found => found != null);
    return name == null ? [] : [{ path, name }];
  });
}

/** Keeps the definitions some other own-code file references (an unused theme is not the app's theme). */
async function referenced(params: { ctx: PolicyContext; found: { path: string; name: string }[] }): Promise<string[]> {
  const { ctx, found } = params;
  if (found.length === 0) return [];
  const views = await searchTurn({ ctx, items: found.map(({ name }) => ({ path: scopeOf(ctx), pattern: name, kind: 'content', wholeWord: true, caseSensitive: true, maxMatches: 20 })) });
  return found.filter(({ path }, index) => (views[index]?.hits ?? []).some(hit => hit.path !== path && isOwnCode(hit.path))).map(({ path }) => path);
}

/**
 * The theme the app uses. Expert: search for `createTheme(` and token-typed constants, then check each one is
 * referenced elsewhere (dead themes, tests and stories drop out). Naive: a loose "theme" search, reading every
 * candidate, then the same reference check. Decoy: every file mentioning a theme. Lazy: the first definition.
 */
export async function solveTheme(params: { ctx: PolicyContext; style: Style }): Promise<SolverAnswer> {
  const { ctx, style } = params;
  const scope = scopeOf(ctx);
  if (style === 'decoy') return filesAnswer(hitPaths(await searchTurn({ ctx, items: [{ path: scope, pattern: 'theme', kind: 'content', includeIgnored: true, maxMatches: 500 }] })));
  if (style === 'naive') {
    await orient(ctx);
    const loose = await searchTurn({ ctx, items: [{ path: scope, pattern: 'theme', kind: 'content', includeIgnored: true, maxMatches: 500 }] });
    await readTurn({ ctx, paths: hitPaths(loose).filter(isOwnCode), perCall: NAIVE_READ_BATCH });
  }
  const views = await searchTurn({ ctx, items: DEFINITION_PATTERNS.map(pattern => ({ path: scope, pattern, regex: true, caseSensitive: true, kind: 'content' })) });
  const found = definitions(views);
  if (style === 'lazy') return filesAnswer(found.slice(0, LAZY_TAKE - 1).map(({ path }) => path));
  return filesAnswer(await referenced({ ctx, found }));
}
