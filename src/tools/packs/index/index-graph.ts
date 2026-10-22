import { createHash } from 'node:crypto';
import type { FileCard, IndexedFile } from './index-types.js';

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

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
 * What only the whole repository tells: imports resolved, importers, exports nobody else references (in code, any
 * file: tests count as users), mounted routers, and re-export files of a theme definition tagged `theme-reexport`.
 */
export function linkCards(cards: FileCard[]): { files: Map<string, IndexedFile>; mountedRouters: Set<string> } {
  const paths = new Set(cards.map(({ path }) => path));
  const resolved = cards.map(card => ({ ...card, imports: card.imports.map(entry => {
    const target = resolveSpecifier({ from: card.path, specifier: entry.specifier, paths });
    return target == null ? entry : { ...entry, resolved: target };
  }) }));
  const importers = new Map<string, Set<string>>();
  for (const card of resolved) for (const { resolved: target } of card.imports) if (target != null) importers.set(target, (importers.get(target) ?? new Set()).add(card.path));
  // How many code files mention each identifier: the declaring file is one, so 1 means no other file uses it.
  const mentions = new Map<string, number>();
  for (const card of resolved) if (CODE.test(card.path)) for (const identifier of card.identifiers) mentions.set(identifier, (mentions.get(identifier) ?? 0) + 1);
  const byPath = new Map(resolved.map(card => [card.path, card]));
  const mountedRouters = new Set(resolved.flatMap(({ mounts }) => mounts));
  const files = new Map<string, IndexedFile>();
  for (const card of resolved) {
    const reexportsTheme = card.imports.length > 0 && card.functions.length === 0 && card.imports.some(({ isReexport, resolved: target }) => isReexport && target != null && (byPath.get(target)?.tags.includes('theme-definition') ?? false));
    const tags = reexportsTheme && !card.tags.includes('theme-definition') ? [...card.tags, 'theme-reexport' as const].sort() : card.tags;
    const isOwnCode = !card.tags.includes('test') && !card.tags.includes('mock') && !card.tags.includes('story');
    files.set(card.path, {
      ...card, tags,
      importers: [...(importers.get(card.path) ?? [])].sort(),
      unusedExports: isOwnCode ? card.functions.filter(name => (mentions.get(name) ?? 0) <= 1) : [],
    });
  }
  return { files, mountedRouters };
}

/** A version that changes when any indexed file's path or content changes. */
export function indexVersion(cards: Iterable<FileCard>): string {
  const hash = createHash('sha256');
  for (const { path, hash: content } of [...cards].sort((first, second) => (first.path < second.path ? -1 : 1))) hash.update(`${path}\u0000${content}\n`);
  return hash.digest('hex').slice(0, 16);
}
