import type { RepoTree } from '../generate/repo-types.js';
import { isSourceCode, isTestFile, textFiles } from './file-kinds.js';
import { importsOf } from './imports.js';
import { scanSource } from './lexer.js';

/** An exported PascalCase function or arrow whose body returns a JSX element (`return (<X`, `return <X`, `=> (<X`, `=> <X`). */
const COMPONENT_EXPORT = /export\s+(?:function\s+([A-Z]\w*)\s*\(|const\s+([A-Z]\w*)\s*=\s*\()/g;
const RETURNS_JSX = /(?:return|=>)\s*\(?\s*<[A-Za-z]/;
const PII_FIELDS = ['fullName', 'firstName', 'lastName', 'email', 'phone', 'phoneNumber', 'address', 'postalAddress', 'dateOfBirth', 'nationalId'];
const PII_RENDER = new RegExp(`\\{[^{}]*\\.(?:${PII_FIELDS.join('|')})\\b[^{}]*\\}`);
const PII_DECLARATION = new RegExp(`^\\s*(?:${PII_FIELDS.join('|')})\\??:\\s*(?:string|number|boolean|Date|z\\.)`, 'm');
/** The privacy service's operations; a handler calling one implements consent, erasure, export or retention. */
const PRIVACY_CALL = /\b(?:recordConsent|withdrawConsent|eraseSubject|exportSubjectData|purgeExpiredRecords)\s*\(/;
const HANDLER_EXPORT = /export\s+async\s+function\s+\w+\s*\(\s*\w+\s*:\s*ApiRequest\b/;
const TOKEN_CONSTANT = /export\s+const\s+\w+\s*:\s*\w+Tokens\s*=/;

/** Whether a source file declares a React component (code only: markup in strings does not count). */
export function isComponentFile(params: { path: string; text: string }): boolean {
  const { path, text } = params;
  if (!/\.[jt]sx$/.test(path) || !isSourceCode(path)) return false;
  const { code } = scanSource(text);
  for (const match of code.matchAll(COMPONENT_EXPORT)) {
    const body = code.slice((match.index ?? 0) + match[0].length);
    const end = body.search(/\n(?:export|function|const)\s/);
    if (RETURNS_JSX.test(end < 0 ? body : body.slice(0, end))) return true;
  }
  return false;
}

export function reactComponents(tree: RepoTree): string[] {
  return textFiles(tree).filter(isComponentFile).map(({ path }) => path);
}

/** Component files whose JSX shows a personal-data field (`{person.email}`, `{format(person.address)}`). */
export function customerDataUi(tree: RepoTree): string[] {
  return textFiles(tree).filter(file => isComponentFile(file) && PII_RENDER.test(scanSource(file.text).code)).map(({ path }) => path);
}

/** Source files declaring a typed personal-data field (interfaces, types, zod schemas). */
export function piiDeclarations(tree: RepoTree): string[] {
  return textFiles(tree).filter(({ path, text }) => isSourceCode(path) && PII_DECLARATION.test(scanSource(text).code)).map(({ path }) => path);
}

/** API handlers (exported async functions taking an `ApiRequest`) that call a privacy operation. */
export function privacyHandlers(tree: RepoTree): string[] {
  return textFiles(tree).filter(({ path, text }) => {
    if (!isSourceCode(path)) return false;
    const { code } = scanSource(text);
    return HANDLER_EXPORT.test(code) && PRIVACY_CALL.test(code);
  }).map(({ path }) => path);
}

/** Every source file reachable from `entry` through relative imports (static and dynamic). */
export function reachableFrom(params: { tree: RepoTree; entry: string }): Set<string> {
  const { tree, entry } = params;
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop() ?? '';
    const text = tree.get(path);
    if (seen.has(path) || typeof text !== 'string') continue;
    seen.add(path);
    for (const edge of importsOf({ tree, path, text })) if (edge.resolved != null) pending.push(edge.resolved);
  }
  return seen;
}

/** Files that define theme values (a `createTheme` call or a `...Tokens`-typed constant) and that the app entry reaches. */
export function themeDefinitions(params: { tree: RepoTree; entry: string }): string[] {
  const { tree, entry } = params;
  const reachable = reachableFrom({ tree, entry });
  return textFiles(tree).filter(({ path, text }) => {
    if (!reachable.has(path) || !isSourceCode(path)) return false;
    const { code } = scanSource(text);
    return /\bcreateTheme\s*\(/.test(code.replace(/import[^;]*;/g, '')) || TOKEN_CONSTANT.test(code);
  }).map(({ path }) => path);
}

/** Test files whose imports resolve to `module`. */
export function testsOf(params: { tree: RepoTree; module: string }): string[] {
  const { tree, module } = params;
  return textFiles(tree).filter(({ path, text }) => isTestFile(path) && /\.[jt]sx?$/.test(path) && importsOf({ tree, path, text }).some(({ resolved }) => resolved === module)).map(({ path }) => path);
}
