import type { ItemOutcome } from './tool-turns.js';

/** One line a search matched (1-based), with the context lines when asked for. */
export interface MatchLine {
  line: number;
  text: string;
  before: string[];
  after: string[];
}

/** One file of a search, its path relative to the repository root. */
export interface SearchHit {
  path: string;
  count: number;
  matches: MatchLine[];
}

export interface SearchView {
  ok: boolean;
  hits: SearchHit[];
  totalMatches: number;
  truncated: boolean;
  skipped: Record<string, number>;
  samples: Record<string, string[]>;
}

export interface ReadView {
  path: string;
  ok: boolean;
  text: string;
  lines: string[];
  binary: boolean;
}

export interface ListEntry {
  path: string;
  type: string;
}

/** `dir` joined with a path relative to it (`.` is the root). */
export function joinPath(dir: string, relative: string): string {
  const base = dir.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '');
  return base === '' ? relative : `${base}/${relative}`;
}

const asArray = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value as Record<string, unknown>[] : []);
const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value != null ? value as Record<string, unknown> : {});

export function searchView(outcome: ItemOutcome): SearchView {
  const { item, ok, result = {} } = outcome;
  const base = String(item['path'] ?? '.');
  // Searching a single file reports it by its base name.
  const pathOf = (relative: string): string => (base === relative || base.endsWith(`/${relative}`) ? base.replace(/^\.\//, '') : joinPath(base, relative));
  const hits = asArray(result['files']).map((file): SearchHit => ({
    path: pathOf(String(file['path'] ?? '')),
    count: Number(file['count'] ?? 0),
    matches: asArray(file['matches']).map(match => ({ line: Number(match['line'] ?? 0), text: String(match['text'] ?? ''), before: (match['before'] as string[] | undefined) ?? [], after: (match['after'] as string[] | undefined) ?? [] })),
  }));
  const skipped = asRecord(result['skipped']);
  const samples = asRecord(skipped['samples']) as Record<string, string[]>;
  return {
    ok, hits, totalMatches: Number(result['totalMatches'] ?? 0), truncated: result['truncated'] === true,
    skipped: asRecord(skipped['counts']) as Record<string, number>,
    samples: Object.fromEntries(Object.entries(samples).map(([reason, paths]) => [reason, paths.map(path => joinPath(base, path))])),
  };
}

export function readView(outcome: ItemOutcome): ReadView {
  const { item, ok, result = {} } = outcome;
  const text = typeof result['text'] === 'string' ? result['text'] : '';
  return { path: String(item['path'] ?? ''), ok, text, lines: text.split('\n'), binary: result['binary'] === true };
}

export function listEntries(outcome: ItemOutcome): ListEntry[] {
  const base = String(outcome.item['path'] ?? '.');
  return asArray(outcome.result?.['entries']).map(entry => ({ path: joinPath(base, String(entry['path'] ?? '')), type: String(entry['type'] ?? '') }));
}
