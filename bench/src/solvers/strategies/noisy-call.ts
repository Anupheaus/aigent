import type { SolverAnswer } from '../../task-spec.js';
import { codeLines } from '../judge/code-lines.js';
import { isOwnCode } from '../judge/paths.js';
import type { PolicyContext } from '../policy-types.js';
import { filesAnswer, hitPaths, LAZY_TAKE, NAIVE_READ_BATCH, orient, readTurn, scopeOf, searchTurn } from './shared.js';
import type { Style } from './shared.js';

const WIDE_MATCHES = 500;

/** Whether a file imports `verb` from an analytics module and calls it in code. */
export function callsImported(params: { text: string; verb: string }): boolean {
  const { text, verb } = params;
  const imports = new RegExp(`import\\s*\\{[^}]*\\b${verb}\\b[^}]*\\}\\s*from\\s*'[^']*analytics'`).test(text);
  return imports && codeLines(text).some(line => !line.trimStart().startsWith('import') && new RegExp(`(?<![\\w$.])${verb}\\s*\\(`).test(line));
}

/**
 * Callers of a common imported function. Expert: in one turn, a regex for the import and one for the call, crossed,
 * tests dropped. Naive: a loose search for the call, then reading every candidate. Decoy: every `verb(` taken.
 * Lazy: the first hits of the call search.
 */
export async function solveNoisyCall(params: { ctx: PolicyContext; verb: string; style: Style }): Promise<SolverAnswer> {
  const { ctx, verb, style } = params;
  const scope = scopeOf(ctx);
  if (style === 'good' || style === 'optimised') {
    const [importers, callers] = await searchTurn({ ctx, items: [
      { path: scope, pattern: `import \\{[^}]*\\b${verb}\\b[^}]*\\} from '[^']*analytics'`, regex: true, kind: 'content', caseSensitive: true, maxMatches: WIDE_MATCHES },
      { path: scope, pattern: `\\b${verb}\\(`, regex: true, kind: 'content', caseSensitive: true, maxMatches: WIDE_MATCHES },
    ] });
    const calling = new Set(hitPaths(callers ? [callers] : []));
    return filesAnswer(hitPaths(importers ? [importers] : []).filter(path => calling.has(path) && isOwnCode(path)));
  }
  if (style === 'naive') await orient(ctx);
  const views = await searchTurn({ ctx, items: [{ path: scope, pattern: `${verb}(`, kind: 'content', includeIgnored: style !== 'lazy', maxMatches: style === 'lazy' ? LAZY_TAKE : WIDE_MATCHES }] });
  if (style === 'decoy' || style === 'lazy') return filesAnswer(hitPaths(views).slice(0, style === 'lazy' ? LAZY_TAKE : undefined));
  const reads = await readTurn({ ctx, paths: hitPaths(views).filter(isOwnCode), perCall: NAIVE_READ_BATCH });
  return filesAnswer(reads.filter(({ text }) => callsImported({ text, verb })).map(({ path }) => path));
}
