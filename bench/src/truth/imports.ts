import type { RepoTree } from '../generate/repo-types.js';
import { scanSource } from './lexer.js';

/** A name an import binds: `imported` from the module (`default`; never `*`) as `local` in the importing file. */
export interface ImportBinding {
  imported: string;
  local: string;
}

/** One import or re-export of a module: what it names and the repo file it resolves to (relative specifiers only). */
export interface ImportEdge {
  specifier: string;
  /** The imported (or re-exported) original names; empty for side-effect, namespace and dynamic imports. */
  names: string[];
  bindings: ImportBinding[];
  resolved?: string;
  isDynamic: boolean;
  isReexport: boolean;
  /** Reaches the whole module: `* as ns`, `export *` or a dynamic import. */
  isWholeModule: boolean;
}

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
const STATIC_IMPORT = /\b(import|export)\s+(?:type\s+)?([^;]*?)\s*from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const NAME = /^[A-Za-z_$][\w$]*$/;

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

/**
 * A clause read token by token (the truth's own reading, independent of the index's): a default name, `* [as ns]`,
 * and `{ a, b as c }` entries, separated by top-level commas.
 */
function readClause(params: { clause: string; isReexport: boolean }): { bindings: ImportBinding[]; isWholeModule: boolean } {
  const { clause, isReexport } = params;
  const bindings: ImportBinding[] = [];
  let isWholeModule = false;
  const open = clause.indexOf('{');
  const close = clause.indexOf('}', open);
  const inner = open < 0 || close < 0 ? '' : clause.slice(open + 1, close);
  const outer = open < 0 || close < 0 ? clause : `${clause.slice(0, open)} ${clause.slice(close + 1)}`;
  for (const part of outer.split(',').map(piece => piece.trim()).filter(piece => piece !== '')) {
    const words = part.split(/\s+/);
    if (words[0] === '*') isWholeModule = true;
    else if (!isReexport && words.length === 1 && NAME.test(part)) bindings.push({ imported: 'default', local: part });
  }
  for (const entry of inner.split(',').map(piece => piece.trim()).filter(piece => piece !== '')) {
    const words = entry.split(/\s+/).filter(word => word !== 'type');
    const imported = words[0] ?? '';
    const local = words[1] === 'as' ? words[2] ?? imported : imported;
    if (NAME.test(imported)) bindings.push({ imported, local });
  }
  return { bindings, isWholeModule };
}

/** Every import, re-export and dynamic import in a source file, skipping any inside comments or strings. */
export function importsOf(params: { tree: RepoTree; path: string; text: string }): ImportEdge[] {
  const { tree, path, text } = params;
  const { code } = scanSource(text);
  const isCode = (offset: number): boolean => code[offset] !== ' ';
  const edges: ImportEdge[] = [];
  for (const match of text.matchAll(STATIC_IMPORT)) {
    if (!isCode(match.index ?? 0)) continue;
    const specifier = match[3] ?? '';
    const isReexport = match[1] === 'export';
    const { bindings, isWholeModule } = readClause({ clause: match[2] ?? '', isReexport });
    const resolved = resolveSpecifier({ tree, from: path, specifier });
    edges.push({ specifier, names: bindings.filter(({ imported }) => imported !== 'default').map(({ imported }) => imported), bindings, isDynamic: false, isReexport, isWholeModule, ...(resolved == null ? {} : { resolved }) });
  }
  for (const match of text.matchAll(DYNAMIC_IMPORT)) {
    if (!isCode(match.index ?? 0)) continue;
    const specifier = match[1] ?? '';
    const resolved = resolveSpecifier({ tree, from: path, specifier });
    edges.push({ specifier, names: [], bindings: [], isDynamic: true, isReexport: false, isWholeModule: true, ...(resolved == null ? {} : { resolved }) });
  }
  return edges;
}
