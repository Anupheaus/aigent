import type { RepoTree } from '../generate/repo-types.js';
import { isGeneratedOrVendored, isSourceCode, isTestFile, textFiles } from './file-kinds.js';
import { importsOf } from './imports.js';
import { codeIdentifiers, scanSource } from './lexer.js';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regular files whose base name is exactly `name` (case-sensitive), wherever they are. */
export function filesNamed(params: { tree: RepoTree; name: string }): string[] {
  const { tree, name } = params;
  return [...tree.entries()].filter(([path, entry]) => typeof entry !== 'object' || entry instanceof Uint8Array ? path.slice(path.lastIndexOf('/') + 1) === name : false).map(([path]) => path).sort();
}

/**
 * Hand-written source files using `identifier` as a code token (whole word, exact case, outside comments and strings).
 * `includeTests` also counts tests (never mocks); `exclude` drops paths (e.g. denied ones).
 */
export function identifierFiles(params: { tree: RepoTree; identifier: string; includeTests?: boolean; exclude?: (path: string) => boolean }): string[] {
  const { tree, identifier, includeTests = false, exclude = () => false } = params;
  const eligible = (path: string): boolean => (isSourceCode(path) || (includeTests && /\.[cm]?[jt]sx?$/.test(path) && isTestFile(path) && !path.includes('/__mocks__/') && !isGeneratedOrVendored(path))) && !exclude(path);
  return textFiles(tree).filter(({ path, text }) => eligible(path) && text.includes(identifier) && codeIdentifiers(scanSource(text).code).has(identifier)).map(({ path }) => path);
}

const normalise = (text: string): string => text.toLowerCase().replace(/[_-]/g, '');

/** Text files (not generated, vendored or lockfiles) mentioning `identifier` in any case or with `_`/`-` separators. */
export function anyCaseFiles(params: { tree: RepoTree; identifier: string }): string[] {
  const { tree, identifier } = params;
  const needle = normalise(identifier);
  return textFiles(tree).filter(({ path, text }) => !isGeneratedOrVendored(path) && normalise(text).includes(needle)).map(({ path }) => path);
}

/** Text files (not generated, vendored or lockfiles) containing `word` as a whole word, exact case, anywhere. */
export function wholeWordFiles(params: { tree: RepoTree; word: string }): string[] {
  const { tree, word } = params;
  const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(word)}(?![\\w$])`);
  return textFiles(tree).filter(({ path, text }) => !isGeneratedOrVendored(path) && pattern.test(text)).map(({ path }) => path);
}

/** The module that declares `export function <verb>(`, when exactly one source file does. */
function definingModules(params: { tree: RepoTree; verb: string }): Set<string> {
  const { tree, verb } = params;
  const declaration = new RegExp(`\\bexport\\s+function\\s+${escapeRegExp(verb)}\\s*\\(`);
  return new Set(textFiles(tree).filter(({ path, text }) => isSourceCode(path) && declaration.test(scanSource(text).code)).map(({ path }) => path));
}

/** Source files that import `verb` from the module defining it and call it. */
export function importedCallFiles(params: { tree: RepoTree; verb: string }): string[] {
  const { tree, verb } = params;
  const modules = definingModules({ tree, verb });
  const call = new RegExp(`(?<![\\w$.])${escapeRegExp(verb)}\\s*\\(`);
  return textFiles(tree).filter(({ path, text }) => {
    if (!isSourceCode(path) || !text.includes(verb)) return false;
    const imported = importsOf({ tree, path, text }).some(edge => edge.resolved != null && modules.has(edge.resolved) && edge.names.includes(verb));
    return imported && call.test(scanSource(text).code);
  }).map(({ path }) => path);
}
