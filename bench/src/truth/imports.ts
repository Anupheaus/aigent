import type { RepoTree } from '../generate/repo-types.js';
import { scanSource } from './lexer.js';

/** One import or re-export of a module: what it names and the repo file it resolves to (relative specifiers only). */
export interface ImportEdge {
  specifier: string;
  /** The imported (or re-exported) names; empty for side-effect and namespace imports. */
  names: string[];
  resolved?: string;
  isDynamic: boolean;
}

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
const STATIC_IMPORT = /\b(?:import|export)\s+(?:type\s+)?([^;]*?)\s*from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** The repo path a relative specifier names from `from`, or undefined (bare packages, missing files). */
export function resolveSpecifier(params: { tree: RepoTree; from: string; specifier: string }): string | undefined {
  const { tree, from, specifier } = params;
  if (!specifier.startsWith('.')) return undefined;
  const parts = from.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  const base = parts.join('/');
  return RESOLVE_SUFFIXES.map(suffix => `${base}${suffix}`).find(candidate => typeof tree.get(candidate) === 'string');
}

const namesOf = (clause: string): string[] => {
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces?.[1] == null) return [];
  return braces[1].split(',').map(part => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? '').filter(name => name !== '');
};

/** Every import, re-export and dynamic import in a source file, skipping any inside comments or strings. */
export function importsOf(params: { tree: RepoTree; path: string; text: string }): ImportEdge[] {
  const { tree, path, text } = params;
  const { code } = scanSource(text);
  const isCode = (offset: number): boolean => code[offset] !== ' ';
  const edges: ImportEdge[] = [];
  for (const match of text.matchAll(STATIC_IMPORT)) {
    if (!isCode(match.index ?? 0)) continue;
    const specifier = match[2] ?? '';
    const resolved = resolveSpecifier({ tree, from: path, specifier });
    edges.push({ specifier, names: namesOf(match[1] ?? ''), isDynamic: false, ...(resolved == null ? {} : { resolved }) });
  }
  for (const match of text.matchAll(DYNAMIC_IMPORT)) {
    if (!isCode(match.index ?? 0)) continue;
    const specifier = match[1] ?? '';
    const resolved = resolveSpecifier({ tree, from: path, specifier });
    edges.push({ specifier, names: [], isDynamic: true, ...(resolved == null ? {} : { resolved }) });
  }
  return edges;
}
