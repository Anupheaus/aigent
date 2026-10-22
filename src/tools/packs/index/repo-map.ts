import type { IndexedFile, IndexSnapshot } from './index-types.js';

/** A directory in the map: files below it (all depths) by language. */
export interface MapDirectory {
  path: string;
  files: number;
  languages: Record<string, number>;
}

export interface RepoMap {
  version: string;
  totalFiles: number;
  languages: Record<string, number>;
  tags: Record<string, number>;
  directories: MapDirectory[];
  /** Directories left out by `maxEntries` (the largest are shown). */
  omittedDirectories: number;
}

const count = (values: string[]): Record<string, number> => Object.fromEntries(Object.entries(values.reduce<Record<string, number>>((totals, value) => ({ ...totals, [value]: (totals[value] ?? 0) + 1 }), {})).sort(([first], [second]) => first.localeCompare(second)));

/** Directories down to `depth` below `path` with their file counts: the cheap overview instead of listing thousands of files. */
export function repoMap(params: { snapshot: IndexSnapshot; path?: string; depth: number; maxEntries: number }): RepoMap {
  const { snapshot, path = '', depth, maxEntries } = params;
  const prefix = path === '' || path === '.' ? '' : `${path.replace(/\/+$/, '')}/`;
  const files: IndexedFile[] = [...snapshot.files.values()].filter(file => file.path.startsWith(prefix));
  const directories = new Map<string, IndexedFile[]>();
  for (const file of files) {
    const parts = file.path.slice(prefix.length).split('/').slice(0, -1);
    for (let level = 1; level <= Math.min(depth, parts.length); level += 1) {
      const key = prefix + parts.slice(0, level).join('/');
      directories.set(key, [...(directories.get(key) ?? []), file]);
    }
  }
  const ranked = [...directories.entries()].map(([directory, members]) => ({ path: directory, files: members.length, languages: count(members.map(({ language }) => language)) }))
    .sort((first, second) => second.files - first.files || first.path.localeCompare(second.path));
  const shown = ranked.slice(0, maxEntries).sort((first, second) => first.path.localeCompare(second.path));
  return { version: snapshot.version, totalFiles: files.length, languages: count(files.map(({ language }) => language)), tags: count(files.flatMap(({ tags }) => tags)), directories: shown, omittedDirectories: ranked.length - shown.length };
}
