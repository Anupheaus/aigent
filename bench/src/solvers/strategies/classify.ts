import type { SolverAnswer } from '../../task-spec.js';
import { codeLines } from '../judge/code-lines.js';
import { declaresComponent, declaresPersonalData, isComponentSource, PII_DECLARATION_PATTERN, PII_FIELD_NAMES, PII_RENDER_PATTERN, rendersPersonalData } from '../judge/content.js';
import { isOwnCode } from '../judge/paths.js';
import type { PolicyContext } from '../policy-types.js';
import type { SearchView } from '../views.js';
import { filesAnswer, hitPaths, LAZY_TAKE, NAIVE_READ_BATCH, orient, readTurn, scopeOf, searchTurn } from './shared.js';
import type { Style } from './shared.js';

const WIDE_MATCHES = 500;
const COMPONENT_CONTEXT_LINES = 3;

/** Expert's line-level judgement of a component search: each hit's declaration and the lines after it. */
const componentsFromHits = (views: SearchView[]): string[] => views.flatMap(({ hits }) => hits)
  .filter(({ path, matches }) => isOwnCode(path) && matches.some(({ text, after }) => declaresComponent(codeLines([text, ...after].join('\n')))))
  .map(({ path }) => path);

/** The naive and decoy shape: get oriented, search loosely, read every candidate, judge by full content. */
async function readAndJudge(params: { ctx: PolicyContext; items: Record<string, unknown>[]; judge: (text: string) => boolean }): Promise<SolverAnswer> {
  const { ctx, items, judge } = params;
  await orient(ctx);
  const views = await searchTurn({ ctx, items });
  const reads = await readTurn({ ctx, paths: hitPaths(views).filter(isOwnCode), perCall: NAIVE_READ_BATCH });
  return filesAnswer(reads.filter(({ ok, text }) => ok && judge(text)).map(({ path }) => path));
}

/** React component files. Expert: one regex search for exported PascalCase declarations with 3 lines of context. */
export async function solveReact(params: { ctx: PolicyContext; style: Style }): Promise<SolverAnswer> {
  const { ctx, style } = params;
  const scope = scopeOf(ctx);
  if (style === 'naive') return readAndJudge({ ctx, items: [{ path: scope, pattern: '.tsx', kind: 'name', includeIgnored: true, maxMatches: WIDE_MATCHES }], judge: isComponentSource });
  if (style === 'decoy') return filesAnswer(hitPaths(await searchTurn({ ctx, items: [{ path: scope, pattern: '.tsx', kind: 'name', includeIgnored: true, maxMatches: WIDE_MATCHES }] })));
  const views = await searchTurn({ ctx, items: [{ path: scope, pattern: '^export (function|const) [A-Z]', regex: true, caseSensitive: true, kind: 'content', glob: '**/*.tsx', contextLines: COMPONENT_CONTEXT_LINES, maxMatches: WIDE_MATCHES }] });
  const found = componentsFromHits(views);
  return filesAnswer(style === 'lazy' ? found.slice(0, LAZY_TAKE) : found);
}

/** UI showing customer personal data. Expert: one regex search for JSX reading a personal-data field. */
export async function solveCustomerUi(params: { ctx: PolicyContext; style: Style }): Promise<SolverAnswer> {
  const { ctx, style } = params;
  const scope = scopeOf(ctx);
  const loose = { path: scope, pattern: PII_FIELD_NAMES.join('|'), regex: true, kind: 'content', includeIgnored: true, glob: '**/*.tsx', maxMatches: WIDE_MATCHES };
  if (style === 'naive') return readAndJudge({ ctx, items: [loose], judge: rendersPersonalData });
  if (style === 'decoy') return filesAnswer(hitPaths(await searchTurn({ ctx, items: [loose] })));
  const views = await searchTurn({ ctx, items: [{ path: scope, pattern: PII_RENDER_PATTERN, regex: true, caseSensitive: true, kind: 'content', glob: '**/*.tsx', maxMatches: WIDE_MATCHES }] });
  const found = hitPaths(views).filter(isOwnCode);
  return filesAnswer(style === 'lazy' ? found.slice(0, LAZY_TAKE) : found);
}

/** Typed personal-data declarations. Expert: one regex search for the declarations themselves. */
export async function solvePiiFields(params: { ctx: PolicyContext; style: Style }): Promise<SolverAnswer> {
  const { ctx, style } = params;
  const scope = scopeOf(ctx);
  const loose = { path: scope, pattern: 'email|phone|address|birth', regex: true, kind: 'content', includeIgnored: true, maxMatches: WIDE_MATCHES };
  if (style === 'naive') return readAndJudge({ ctx, items: [loose], judge: declaresPersonalData });
  if (style === 'decoy') return filesAnswer(hitPaths(await searchTurn({ ctx, items: [loose] })));
  const views = await searchTurn({ ctx, items: [{ path: scope, pattern: PII_DECLARATION_PATTERN, regex: true, caseSensitive: true, kind: 'content', maxMatches: WIDE_MATCHES }] });
  const found = hitPaths(views).filter(isOwnCode);
  return filesAnswer(style === 'lazy' ? found.slice(0, LAZY_TAKE) : found);
}
