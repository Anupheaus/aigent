import type { SolverAnswer } from '../../task-spec.js';
import { codeOfLine } from '../judge/code-lines.js';
import { baseName, isBuildOrVendor, isCodeFile, isOwnCode, isTestLike, resolveImport } from '../judge/paths.js';
import type { PolicyContext } from '../policy-types.js';
import type { SearchView } from '../views.js';
import { filesAnswer, hitPaths, LAZY_TAKE, NAIVE_READ_BATCH, orient, readTurn, scopeOf, searchExhaustively, searchTurn } from './shared.js';
import type { Style } from './shared.js';

/** Names per alternation search when checking which exports are used. */
const NAMES_PER_SEARCH = 40;
const EXPORT_PATTERN = '^export (async )?function \\w+|^export const \\w+ = (async )?\\(';
const DECLARED = /^export\s+(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/;

/** Test files whose matched import line resolves to `module`. */
function importingTests(params: { view: SearchView | undefined; module: string }): string[] {
  const { view, module } = params;
  const target = module.replace(/\.tsx?$/, '');
  return (view?.hits ?? []).filter(({ path }) => isTestLike(path) && isCodeFile(path)).filter(({ path, matches }) => matches.some(({ text }) => {
    const specifier = /from '([^']+)'/.exec(text)?.[1];
    return specifier != null && resolveImport({ from: path, specifier, known: () => true }) === target;
  })).map(({ path }) => path);
}

/**
 * The tests of a module. Expert: one turn finding the module by name and every import ending in its stem, resolved.
 * Naive: oriented, loose name and content searches, reading every candidate. Decoy: test files named after it.
 * Lazy: the first importing test.
 */
export async function solveTestsFor(params: { ctx: PolicyContext; module: string; style: Style }): Promise<SolverAnswer> {
  const { ctx, module, style } = params;
  const scope = scopeOf(ctx);
  const stem = module.replace(/\.[^.]+$/, '');
  if (style === 'decoy') return filesAnswer(hitPaths(await searchTurn({ ctx, items: [{ path: scope, pattern: stem, kind: 'name', includeIgnored: true }] })).filter(isTestLike));
  if (style === 'naive') await orient(ctx);
  const [named, importers] = await searchTurn({ ctx, items: [
    { path: scope, pattern: module, kind: 'name', caseSensitive: true },
    { path: scope, pattern: `from '[^']*/${stem}'`, regex: true, caseSensitive: true, kind: 'content', ...(style === 'naive' ? { includeIgnored: true } : {}) },
  ] });
  if (style === 'naive') await readTurn({ ctx, paths: hitPaths(importers ? [importers] : []), perCall: NAIVE_READ_BATCH });
  const target = (named?.hits ?? []).map(({ path }) => path).find(path => baseName(path) === module && !isBuildOrVendor(path));
  if (target == null) return { files: [] };
  const tests = importingTests({ view: importers, module: target });
  return filesAnswer(style === 'lazy' ? tests.slice(0, LAZY_TAKE - 1) : tests);
}

/** Exported functions with their declaring files, from an export search. */
function declarations(views: SearchView[]): { name: string; path: string }[] {
  return views.flatMap(({ hits }) => hits).filter(({ path }) => isOwnCode(path)).flatMap(({ path, matches }) => matches.flatMap(({ text }) => {
    const found = DECLARED.exec(text);
    const name = found?.[1] ?? found?.[2];
    return name == null ? [] : [{ name, path }];
  }));
}

/**
 * Exported functions nobody else uses. Expert: one search for every export, then alternation searches (40 names each)
 * read line by line: a name counts as used when its code (not a comment) appears in another code file. Naive: one
 * search per name. Decoy: any textual mention anywhere counts as a use. Lazy: reports the first dead name it sees.
 */
export async function solveDeadExports(params: { ctx: PolicyContext; style: Style }): Promise<SolverAnswer> {
  const { ctx, style } = params;
  const scope = scopeOf(ctx);
  if (style === 'naive') await orient(ctx);
  const found = declarations(await searchExhaustively({ ctx, item: { path: scope, pattern: EXPORT_PATTERN, regex: true, caseSensitive: true, kind: 'content', maxMatches: 500 } }));
  const names = [...new Set(found.map(({ name }) => name))];
  const home = new Map(found.map(({ name, path }) => [name, path]));
  const used = new Set<string>();
  if (style === 'naive') {
    const views = await searchTurn({ ctx, items: names.map(name => ({ path: scope, pattern: name, kind: 'content', wholeWord: true, caseSensitive: true, maxMatches: 5 })) });
    names.forEach((name, index) => { if ((views[index]?.hits ?? []).some(({ path, matches }) => path !== home.get(name) && isCodeFile(path) && !isBuildOrVendor(path) && matches.some(({ text }) => new RegExp(`\\b${name}\\b`).test(codeOfLine(text))))) used.add(name); });
  } else {
    const chunks: string[][] = [];
    for (let start = 0; start < names.length; start += NAMES_PER_SEARCH) chunks.push(names.slice(start, start + NAMES_PER_SEARCH));
    const isDecoy = style === 'decoy';
    const views = await searchTurn({ ctx, items: chunks.map(chunk => ({ path: scope, pattern: isDecoy ? chunk.join('|') : `\\b(${chunk.join('|')})\\b`, regex: true, caseSensitive: !isDecoy, kind: 'content', maxMatches: 500, ...(isDecoy ? { includeIgnored: true } : {}) })) });
    for (const { path, matches } of views.flatMap(({ hits }) => hits)) {
      if (!isDecoy && (!isCodeFile(path) || isBuildOrVendor(path))) continue;
      for (const { text } of matches) {
        if (isDecoy) { for (const name of names) if (path !== home.get(name) && text.includes(name)) used.add(name); continue; }
        for (const token of codeOfLine(text).match(/[\w$]+/g) ?? []) if (home.has(token) && home.get(token) !== path) used.add(token);
      }
    }
  }
  const dead = names.filter(name => !used.has(name)).sort();
  return { text: (style === 'lazy' ? dead.slice(0, 1) : dead).join('\n') };
}
