import { classifyFile } from './classify.js';
import { codeOnly, identifiersOf } from './code-text.js';
import type { CardImport, CardRoute, FileCard } from './index-types.js';

const LANGUAGES: Record<string, string> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json', md: 'md', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml', sql: 'sql' };
const CODE_LANGUAGES = new Set(['ts', 'tsx', 'js', 'jsx']);
const PURPOSE_CHARS = 160;
const STATIC_IMPORT = /\b(import|export)\s+(?:type\s+)?([^;]*?)\s*from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const ROUTE = /\b(\w+)\.(get|post|put|patch|delete)\(\s*['"]([^'"]*)['"]\s*,\s*(\w+)\s*\)/g;

export function languageOf(path: string): string {
  return LANGUAGES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'other';
}

/** The leading comment of code, or the first heading of a document. */
function purposeOf(params: { text: string; language: string }): string | undefined {
  const { text, language } = params;
  const first = text.split('\n').map(line => line.trim()).find(line => line !== '');
  if (first == null) return undefined;
  const found = language === 'md' ? /^#+\s*(.+)$/.exec(first)?.[1] : /^(?:\/\/|\/\*\*?|\*)\s*(.+?)\s*(?:\*\/)?$/.exec(first)?.[1];
  return found?.slice(0, PURPOSE_CHARS);
}

const namesIn = (clause: string, which: 'original' | 'alias'): string[] => {
  const braces = /\{([^}]*)\}/.exec(clause)?.[1];
  if (braces == null) return [];
  return braces.split(',').map(part => part.trim().replace(/^type\s+/, '')).filter(part => part !== '').map(part => {
    const [name = '', alias] = part.split(/\s+as\s+/);
    return which === 'alias' ? alias ?? name : name;
  });
};

/** Imports and re-exports (static and dynamic), read where the code (not a comment or string) has the keyword. */
function importsOf(params: { text: string; code: string }): CardImport[] {
  const { text, code } = params;
  const live = (offset: number): boolean => code[offset] !== ' ';
  const imports: CardImport[] = [];
  for (const match of text.matchAll(STATIC_IMPORT)) {
    if (!live(match.index ?? 0)) continue;
    const isReexport = match[1] === 'export';
    const clause = match[2] ?? '';
    imports.push({ specifier: match[3] ?? '', names: namesIn(clause, isReexport ? 'alias' : 'original'), isReexport });
  }
  for (const match of text.matchAll(DYNAMIC_IMPORT)) if (live(match.index ?? 0)) imports.push({ specifier: match[1] ?? '', names: [], isReexport: false });
  return imports;
}

/** Route registrations in code: the receiver, method, path and handler of each `x.get('/path', handler)`. */
function routesOf(params: { text: string; code: string }): CardRoute[] {
  const { text, code } = params;
  return [...text.matchAll(ROUTE)].filter(match => code[match.index ?? 0] !== ' ').map(match => ({ router: match[1] ?? '', method: (match[2] ?? '').toUpperCase(), path: match[3] ?? '', handler: match[4] ?? '' }));
}

/** Declared top-level names, exported names and exported functions of code. */
function declarationsOf(code: string): { symbols: string[]; exports: string[]; functions: string[] } {
  const symbols = [...code.matchAll(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1] ?? '');
  const exported = [...code.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1] ?? '');
  const functions = [...code.matchAll(/^export\s+(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>))/gm)].map(match => match[1] ?? match[2] ?? '');
  return { symbols: [...new Set(symbols)], exports: [...new Set(exported)], functions: [...new Set(functions)] };
}

/** The card of one file from its content (paths relative to the indexed root; imports resolved later). */
export function buildCard(params: { path: string; text: string; size: number; hash: string }): FileCard {
  const { path, text, size, hash } = params;
  const language = languageOf(path);
  const purpose = purposeOf({ text, language });
  const base = { path, language, size, hash, ...(purpose == null ? {} : { purpose }) };
  if (!CODE_LANGUAGES.has(language)) return { ...base, exports: [], functions: [], symbols: [], imports: [], identifiers: [], routes: [], mounts: [], tags: classifyFile({ path, text, code: '' }) };
  const code = codeOnly(text);
  const imports = importsOf({ text, code });
  const declarations = declarationsOf(code);
  return {
    ...base, ...declarations, exports: [...new Set([...declarations.exports, ...imports.filter(({ isReexport }) => isReexport).flatMap(({ names }) => names)])],
    imports, identifiers: identifiersOf(code), routes: routesOf({ text, code }),
    mounts: [...code.matchAll(/\.use\(\s*(\w+)\s*\)/g)].map(match => match[1] ?? ''),
    tags: classifyFile({ path, text, code }),
  };
}
