import { createHash } from 'node:crypto';
import { isTestMaterial } from './classify.js';
import { usedExports } from './export-usage.js';
import type { FileCard, IndexedFile } from './index-types.js';
import { liveRoutesByFile } from './route-graph.js';

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];

/** The indexed path a relative specifier names from `from`, or undefined (packages, files outside the index). */
export function resolveSpecifier(params: { from: string; specifier: string; paths: ReadonlySet<string> }): string | undefined {
  const { from, specifier, paths } = params;
  if (!specifier.startsWith('.')) return undefined;
  const parts = from.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  const base = parts.join('/');
  return RESOLVE_SUFFIXES.map(suffix => base + suffix).find(candidate => paths.has(candidate));
}

/**
 * What only the whole repository tells: imports resolved, importers, exports no other file uses (resolved through
 * imports; tests count as users), served routes, and re-export files of a theme definition tagged `theme-reexport`.
 */
export function linkCards(cards: FileCard[]): { files: Map<string, IndexedFile> } {
  const paths = new Set(cards.map(({ path }) => path));
  const resolved = cards.map(card => ({ ...card, imports: card.imports.map(entry => {
    const target = resolveSpecifier({ from: card.path, specifier: entry.specifier, paths });
    return target == null ? entry : { ...entry, resolved: target };
  }) }));
  const importers = new Map<string, Set<string>>();
  for (const card of resolved) for (const { resolved: target } of card.imports) if (target != null) importers.set(target, (importers.get(target) ?? new Set()).add(card.path));
  const byPath = new Map(resolved.map(card => [card.path, card]));
  const { used, unresolvedNames } = usedExports(resolved);
  const live = liveRoutesByFile({ cards: resolved, byPath });
  const files = new Map<string, IndexedFile>();
  for (const card of resolved) {
    const reexportsTheme = card.imports.length > 0 && card.functions.length === 0 && card.imports.some(({ isReexport, resolved: target }) => isReexport && target != null && (byPath.get(target)?.tags.includes('theme-definition') ?? false));
    const tags = reexportsTheme && !card.tags.includes('theme-definition') ? [...card.tags, 'theme-reexport' as const].sort() : card.tags;
    // Test material and declaration files only use code; their own exports are never "dead".
    const isOwnCode = !isTestMaterial(card.tags) && !card.path.endsWith('.d.ts');
    const usedHere = used.get(card.path);
    files.set(card.path, {
      ...card, tags,
      importers: [...(importers.get(card.path) ?? [])].sort(),
      unusedExports: isOwnCode ? card.functions.filter(name => !(usedHere?.has(name) ?? false) && !unresolvedNames.has(name)) : [],
      liveRoutes: live.get(card.path) ?? [],
    });
  }
  return { files };
}

/** A version that changes when any indexed file's path or content changes. */
export function indexVersion(cards: Iterable<FileCard>): string {
  const hash = createHash('sha256');
  for (const { path, hash: content } of [...cards].sort((first, second) => (first.path < second.path ? -1 : 1))) hash.update(`${path}\u0000${content}\n`);
  return hash.digest('hex').slice(0, 16);
}
