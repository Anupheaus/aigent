import { contentTags, isTestMaterial, pathTags } from './classify.js';
import { codeOnly, identifiersOf } from './code-text.js';
import { callArgs, nameArg, stringArg } from './call-args.js';
import type { CardBinding, CardImport, CardMount, CardRoute, ContentFacts, FileCard } from './index-types.js';

/**
 * Version of what `analyseContent` derives (parsers and classifier rules). Cached facts are keyed by it, so a change to
 * either must bump it, or a shared store would serve facts an older classifier derived.
 */
export const CONTENT_FACTS_VERSION = 3;
const LANGUAGES: Record<string, string> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json', md: 'md', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml', sql: 'sql' };
const CODE_LANGUAGES = new Set(['ts', 'tsx', 'js', 'jsx']);
const JSX_LANGUAGES = new Set(['tsx', 'jsx']);
const PURPOSE_CHARS = 160;
const STATIC_IMPORT = /\b(import|export)\s+(?:type\s+)?([^;]*?)\s*from\s+['"]([^'"]+)['"]/g;
/** Whole-module loads: dynamic `import('x')` and CommonJS `require('x')`. */
const MODULE_LOAD = /\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;
const ROUTE_CALL = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete)\(/g;
const USE_CALL = /\b([A-Za-z_$][\w$]*)\.use\(/g;
/** A variable made by a router factory: `Router()`, `express.Router()`, `createRouter()`, `new Router()`. */
const ROUTER_DECLARATION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:new\s+)?(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$]*Router\s*\(/g;
const DEFAULT_EXPORT = /^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m;

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

/** What an import or re-export clause binds (`a, { b as c }`, `* as ns`, `{ d }`, `*`). */
function bindingsOf(params: { clause: string; isReexport: boolean }): { bindings: CardBinding[]; isWholeModule: boolean } {
  const { clause, isReexport } = params;
  const braces = /\{([^}]*)\}/.exec(clause)?.[1];
  const named = (braces ?? '').split(',').map(part => part.trim().replace(/^type\s+/, '')).filter(part => part !== '').map(part => {
    const [imported = '', local] = part.split(/\s+as\s+/);
    return { imported: imported.trim(), local: (local ?? imported).trim() };
  });
  const outside = clause.replace(/\{[^}]*\}/, '').trim();
  const namespace = /\*\s*(?:as\s+([A-Za-z_$][\w$]*))?/.exec(outside);
  // `import x from` / `import x, { y } from`: a default binding (re-exports have none).
  const defaultLocal = isReexport ? undefined : /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(outside)?.[1];
  return {
    bindings: [...(defaultLocal == null ? [] : [{ imported: 'default', local: defaultLocal }]), ...(namespace?.[1] == null ? [] : [{ imported: '*', local: namespace[1] }]), ...named],
    isWholeModule: namespace != null,
  };
}

/** Imports and re-exports (static, dynamic and `require`), read where the code (not a comment or string) has the keyword. */
function importsOf(params: { text: string; code: string }): CardImport[] {
  const { text, code } = params;
  const live = (offset: number): boolean => code[offset] !== ' ';
  const imports: CardImport[] = [];
  for (const match of text.matchAll(STATIC_IMPORT)) {
    if (!live(match.index ?? 0)) continue;
    const isReexport = match[1] === 'export';
    const { bindings, isWholeModule } = bindingsOf({ clause: match[2] ?? '', isReexport });
    const named = bindings.filter(({ imported }) => imported !== 'default' && imported !== '*');
    imports.push({ specifier: match[3] ?? '', names: named.map(({ imported, local }) => (isReexport ? local : imported)), bindings, isWholeModule, isReexport });
  }
  for (const match of text.matchAll(MODULE_LOAD)) if (live(match.index ?? 0)) imports.push({ specifier: match[1] ?? '', names: [], bindings: [], isWholeModule: true, isReexport: false });
  return imports;
}

/** Route registrations in code: receiver, method, path and handler of each `x.get('/path', ...middleware, handler)`. */
function routesOf(params: { text: string; code: string }): CardRoute[] {
  const { text, code } = params;
  return [...code.matchAll(ROUTE_CALL)].flatMap(match => {
    const args = callArgs({ code, text, open: (match.index ?? 0) + match[0].length - 1 });
    const path = stringArg(args?.[0]);
    if (args == null || path == null || args.length < 2) return [];
    return [{ router: match[1] ?? '', method: (match[2] ?? '').toUpperCase(), path, handler: nameArg(args.at(-1)) ?? '' }];
  });
}

/** `x.use([path,] ...args)` calls: the receiver, the mount path and the plain names mounted. */
function mountsOf(params: { text: string; code: string }): CardMount[] {
  const { text, code } = params;
  return [...code.matchAll(USE_CALL)].flatMap(match => {
    const args = callArgs({ code, text, open: (match.index ?? 0) + match[0].length - 1 });
    if (args == null || args.length === 0) return [];
    const path = stringArg(args[0]);
    const routers = (path == null ? args : args.slice(1)).flatMap(arg => nameArg(arg) ?? []);
    return [{ receiver: match[1] ?? '', path: path ?? '', routers }];
  });
}

const defaultExportOf = (code: string): { defaultExport?: string } => {
  const name = DEFAULT_EXPORT.exec(code)?.[1];
  return name == null ? {} : { defaultExport: name };
};

/** Declared top-level names, exported names and exported functions of code. */
function declarationsOf(code: string): { symbols: string[]; exports: string[]; functions: string[] } {
  const symbols = [...code.matchAll(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1] ?? '');
  const exported = [...code.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1] ?? '');
  const functions = [...code.matchAll(/^export\s+(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>))/gm)].map(match => match[1] ?? match[2] ?? '');
  return { symbols: [...new Set(symbols)], exports: [...new Set(exported)], functions: [...new Set(functions)] };
}

/**
 * What a file's content says, given its language: everything on a card except the path facts. It depends only on the
 * bytes and the language, so it is what the index caches by content hash (under `CONTENT_FACTS_VERSION`).
 */
export function analyseContent(params: { language: string; text: string }): ContentFacts {
  const { language, text } = params;
  const purpose = purposeOf({ text, language });
  const base = purpose == null ? {} : { purpose };
  if (!CODE_LANGUAGES.has(language)) return { ...base, exports: [], functions: [], symbols: [], imports: [], identifiers: [], routes: [], mounts: [], routers: [], contentTags: [] };
  const code = codeOnly(text);
  const imports = importsOf({ text, code });
  const declarations = declarationsOf(code);
  return {
    ...base, ...declarations, exports: [...new Set([...declarations.exports, ...imports.filter(({ isReexport }) => isReexport).flatMap(({ names }) => names)])],
    imports, identifiers: identifiersOf(code), routes: routesOf({ text, code }),
    mounts: mountsOf({ text, code }), routers: [...new Set([...code.matchAll(ROUTER_DECLARATION)].map(match => match[1] ?? ''))],
    ...defaultExportOf(code),
    contentTags: contentTags({ isJsx: JSX_LANGUAGES.has(language), text, code }),
  };
}

/** The card of a file at `path` from its content facts: the language, size and tags its path gives are its own. */
export function cardFor(params: { path: string; size: number; hash: string; facts: ContentFacts }): FileCard {
  const { path, size, hash, facts: { contentTags: tagsFromContent, ...facts } } = params;
  const byPath = pathTags(path);
  // Test material is not classified by its code (a mock handler is not an API handler).
  const tags = [...new Set([...byPath, ...(isTestMaterial(byPath) ? [] : tagsFromContent)])].sort();
  return { path, language: languageOf(path), size, hash, ...facts, tags };
}

/** The card of one file from its content (paths relative to the indexed root; imports resolved later). */
export function buildCard(params: { path: string; text: string; size: number; hash: string }): FileCard {
  const { path, text, size, hash } = params;
  return cardFor({ path, size, hash, facts: analyseContent({ language: languageOf(path), text }) });
}
