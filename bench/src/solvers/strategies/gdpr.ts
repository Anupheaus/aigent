import type { SolverAnswer } from '../../task-spec.js';
import { codeLines } from '../judge/code-lines.js';
import { isOwnCode } from '../judge/paths.js';
import type { PolicyContext } from '../policy-types.js';
import { filesAnswer, hitPaths, LAZY_TAKE, NAIVE_READ_BATCH, orient, readTurn, scopeOf, searchTurn } from './shared.js';
import type { Style } from './shared.js';

const PRIVACY_WORDS = 'consent|erase|erasure|retention|purge';
const PRIVACY_NAME = /consent|erase|purge|retention|subject/i;
const EXPORTED_FUNCTION = /^export\s+async\s+function\s+(\w+)/;
const HANDLER_PATTERN = 'export async function \\w+\\(\\s*\\w+: ApiRequest';

/** A privacy service exports several functions named after privacy operations: those names. */
function privacyOperations(texts: string[]): string[] {
  return texts.flatMap(text => {
    const names = codeLines(text).flatMap(line => EXPORTED_FUNCTION.exec(line)?.[1] ?? []).filter(name => PRIVACY_NAME.test(name));
    return names.length >= 3 ? names : [];
  });
}

/**
 * API handlers implementing GDPR operations. Expert: search the privacy words, read the own-code hits to learn the
 * privacy service's operations, then search in one turn for their callers and for API handlers, and cross them.
 * Naive: oriented, it reads every own-code file of the loose search before the same steps. Decoy: everything mentioning
 * the words. Lazy: the first handlers of the first search.
 */
export async function solveGdpr(params: { ctx: PolicyContext; style: Style }): Promise<SolverAnswer> {
  const { ctx, style } = params;
  const scope = scopeOf(ctx);
  if (style === 'naive') await orient(ctx);
  const words = await searchTurn({ ctx, items: [{ path: scope, pattern: style === 'decoy' ? `gdpr|privacy|${PRIVACY_WORDS}` : PRIVACY_WORDS, regex: true, kind: 'content', includeIgnored: style === 'naive' || style === 'decoy', maxMatches: 500 }] });
  if (style === 'decoy') return filesAnswer(hitPaths(words));
  const candidates = hitPaths(words).filter(isOwnCode);
  if (style === 'lazy') return filesAnswer(candidates.filter(path => path.includes('/api/')).slice(0, LAZY_TAKE));
  const reads = await readTurn({ ctx, paths: candidates, ...(style === 'naive' ? { perCall: NAIVE_READ_BATCH } : {}) });
  const operations = privacyOperations(reads.map(({ text }) => text));
  if (operations.length === 0) return { files: [] };
  const callerItem = { path: scope, pattern: `\\b(${operations.join('|')})\\(`, regex: true, caseSensitive: true, kind: 'content', maxMatches: 500 };
  const handlerItem = { path: scope, pattern: HANDLER_PATTERN, regex: true, caseSensitive: true, kind: 'content', maxMatches: 500 };
  // The naive policy asks one question per turn and re-reads what it found before answering.
  const [callers, handlers] = style === 'naive'
    ? [...await searchTurn({ ctx, items: [callerItem] }), ...await searchTurn({ ctx, items: [handlerItem] })]
    : await searchTurn({ ctx, items: [callerItem, handlerItem] });
  const isHandler = new Set(hitPaths(handlers ? [handlers] : []));
  const answer = hitPaths(callers ? [callers] : []).filter(path => isHandler.has(path) && isOwnCode(path));
  if (style === 'naive') await readTurn({ ctx, paths: answer, perCall: NAIVE_READ_BATCH });
  return filesAnswer(answer);
}
