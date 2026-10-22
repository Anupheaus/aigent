import type { FileTag, IndexedFile, IndexSnapshot } from './index-types.js';

/** One `repo_find` query: every given field must match. */
export interface FindQuery {
  name?: string;
  symbol?: string;
  tags?: FileTag[];
  language?: string;
  /** `METHOD /path`: the live registration, its handler and what the handler calls. */
  route?: string;
  /** Files that import this path. */
  importersOf?: string;
  /** Files with exported functions nobody else uses. */
  unusedExports?: boolean;
  limit: number;
}

/** A file as `repo_find` shows it, with why it matched. */
export interface FoundCard {
  path: string;
  tags: string[];
  reasons: string[];
  exports?: string[];
  unusedExports?: string[];
  importers?: number;
}

const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const isSubsequence = (needle: string, haystack: string): boolean => { let at = 0; for (const char of haystack) if (char === needle[at]) at += 1; return at === needle.length; };
const MAX_EXPORTS_SHOWN = 8;

/** Name match strength: exact base name 3, base name contains it 2, a fuzzy subsequence 1 (case-insensitive for 2 and 1). */
function nameScore(params: { query: string; path: string }): number {
  const { query, path } = params;
  if (base(path) === query) return 3;
  const lower = base(path).toLowerCase();
  if (lower.includes(query.toLowerCase())) return 2;
  return isSubsequence(query.toLowerCase(), lower) ? 1 : 0;
}

const view = (file: IndexedFile, reasons: string[]): FoundCard => ({
  path: file.path, tags: file.tags, reasons,
  ...(file.exports.length === 0 ? {} : { exports: file.exports.slice(0, MAX_EXPORTS_SHOWN) }),
  ...(file.unusedExports.length === 0 ? {} : { unusedExports: file.unusedExports }),
  importers: file.importers.length,
});

/** Cards matching every field of the query, best first (score, then path). */
export function findCards(params: { snapshot: IndexSnapshot; query: FindQuery }): { total: number; cards: FoundCard[] } {
  const { snapshot, query } = params;
  const scored: { file: IndexedFile; score: number; reasons: string[] }[] = [];
  for (const file of snapshot.files.values()) {
    const reasons: string[] = [];
    let score = 0;
    if (query.name != null) { const value = nameScore({ query: query.name, path: file.path }); if (value === 0) continue; score += value; reasons.push(value === 3 ? 'exact name' : value === 2 ? 'name contains' : 'fuzzy name'); }
    if (query.symbol != null) {
      if (file.symbols.includes(query.symbol)) { score += 3; reasons.push('defines symbol'); } else if (file.identifiers.includes(query.symbol)) { score += 1; reasons.push('uses symbol'); } else continue;
    }
    if (query.tags != null && !query.tags.every(tag => file.tags.includes(tag))) continue;
    if (query.language != null && file.language !== query.language) continue;
    if (query.importersOf != null) { if (!file.imports.some(({ resolved }) => resolved === query.importersOf)) continue; reasons.push(`imports ${query.importersOf}`); }
    if (query.unusedExports === true) { if (file.unusedExports.length === 0) continue; reasons.push('unused exports'); }
    if (query.tags != null) reasons.push(`tags ${query.tags.join(', ')}`);
    scored.push({ file, score, reasons });
  }
  scored.sort((first, second) => second.score - first.score || first.file.path.localeCompare(second.file.path));
  return { total: scored.length, cards: scored.slice(0, query.limit).map(({ file, reasons }) => view(file, reasons)) };
}

/** A live route's chain: the registering file, the handler's file, and the files the handler calls into (with their tags). */
export function traceRoute(params: { snapshot: IndexSnapshot; route: string }): { registeredIn: string; handler: string; handlerFile?: string; callees: { path: string; tags: string[] }[] }[] {
  const { snapshot, route } = params;
  const [method = '', path = ''] = route.trim().split(/\s+/);
  return [...snapshot.files.values()].flatMap(file => file.routes
    .filter(entry => entry.method === method.toUpperCase() && entry.path === path && snapshot.mountedRouters.has(entry.router))
    .map(entry => {
      const handlerFile = file.imports.find(({ names }) => names.includes(entry.handler))?.resolved;
      const handler = handlerFile == null ? undefined : snapshot.files.get(handlerFile);
      const callees = (handler?.imports ?? []).filter(({ names, resolved }) => resolved != null && names.some(name => handler?.identifiers.includes(name))).flatMap(({ resolved }) => {
        const target = resolved == null ? undefined : snapshot.files.get(resolved);
        return target == null ? [] : [{ path: target.path, tags: target.tags }];
      });
      return { registeredIn: file.path, handler: entry.handler, ...(handlerFile == null ? {} : { handlerFile }), callees };
    }));
}

/** Files carrying the tags (`any` or `all`), counts first; API route files list their live routes. */
export function filesByTags(params: { snapshot: IndexSnapshot; tags: FileTag[]; match: 'any' | 'all'; excludeTags: FileTag[]; limit: number }): { counts: Record<string, number>; total: number; files: { path: string; tags: string[]; importers: number; routes?: string[] }[] } {
  const { snapshot, tags, match, excludeTags, limit } = params;
  const files = [...snapshot.files.values()].filter(file => (match === 'all' ? tags.every(tag => file.tags.includes(tag)) : tags.some(tag => file.tags.includes(tag))) && !excludeTags.some(tag => file.tags.includes(tag)));
  const counts = Object.fromEntries(tags.map(tag => [tag, files.filter(file => file.tags.includes(tag)).length]));
  return {
    counts, total: files.length,
    files: files.slice(0, limit).map(file => {
      const live = file.routes.filter(({ router }) => snapshot.mountedRouters.has(router)).map(({ method, path }) => `${method} ${path}`);
      return { path: file.path, tags: file.tags, importers: file.importers.length, ...(live.length === 0 ? {} : { routes: live }) };
    }),
  };
}
