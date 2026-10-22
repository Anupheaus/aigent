import type { FileTag } from './index-types.js';

const PII_FIELDS = 'fullName|firstName|lastName|givenName|familyName|email|emailAddress|phone|phoneNumber|mobile|address|postalAddress|streetAddress|postcode|zipCode|dateOfBirth|birthDate|dob|nationalId|ssn';
const COMPONENT_EXPORT = /^export\s+(?:default\s+)?(?:function\s+([A-Z]\w*)\s*\(|const\s+([A-Z]\w*)\s*(?::[^=]+)?=\s*(?:\([^)]*\)|\w+)\s*=>)/gm;
const RETURNS_JSX = /(?:return|=>)\s*\(?\s*<[A-Za-z>]/;
const PII_RENDER = new RegExp(`\\{[^{}]*\\.(?:${PII_FIELDS})\\b[^{}]*\\}`);
const PII_DECLARATION = new RegExp(`^\\s*(?:readonly\\s+)?['"]?(?:${PII_FIELDS})['"]?\\??\\s*:\\s*(?:string|number|boolean|Date|z\\.|yup\\.|Joi\\.)`, 'm');
const HANDLER = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)\s*\(\s*(\w+)\s*(?::\s*(\w+))?|const\s+(\w+)\s*(?::\s*[\w<>, ]+)?=\s*(?:async\s*)?\(\s*(\w+)\s*(?::\s*(\w+))?)/gm;
const GDPR_RULES: readonly [FileTag, RegExp][] = [
  ['gdpr-consent', /consent/i],
  ['gdpr-deletion', /erase|erasure|forget|anonymi[sz]e|delete(?:Subject|Personal|UserData|Account)|purgeUser/i],
  ['gdpr-export', /export\w*(?:Subject|Personal|User)Data|dataExport|portab|subjectAccess/i],
  ['gdpr-retention', /retention|purgeExpired|expireRecords|purgeOld/i],
];

const isTestPath = (path: string): boolean => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)__tests__\//.test(path);
const isMockPath = (path: string): boolean => /(^|\/)__mocks__\//.test(path) || /\.mocks?\.[jt]sx?$/.test(path);
const isStoryPath = (path: string): boolean => /\.stories\.[jt]sx?$/.test(path);
const isConfigPath = (path: string): boolean => /(^|\/)(package\.json|tsconfig[\w.-]*\.json|\.eslintrc[\w.]*|vite\.config\.\w+|vitest\.config\.\w+|webpack\.config\.\w+|\.prettierrc[\w.]*)$/.test(path) || /\.(ya?ml|toml|ini)$/.test(path) || /(^|\/)config\//.test(path);

/** Exported PascalCase functions or arrows whose body returns JSX (strings were blanked, so markup in a string never counts). */
export function declaresComponent(code: string): boolean {
  for (const match of code.matchAll(COMPONENT_EXPORT)) {
    const rest = code.slice((match.index ?? 0) + match[0].length);
    const end = rest.search(/\n(?:export|function|const|class)\s/);
    if (RETURNS_JSX.test(end < 0 ? rest : rest.slice(0, end)) || /^\s*\(?\s*<[A-Za-z>]/.test(rest)) return true;
  }
  return false;
}

/** Exported functions that take a request (`(req, res)`, `(request: ApiRequest)`, `Request`-typed) or are named `...Handler`. */
export function declaresHandler(code: string): boolean {
  for (const match of code.matchAll(HANDLER)) {
    const name = match[1] ?? match[4] ?? '';
    const parameter = match[2] ?? match[5] ?? '';
    const type = match[3] ?? match[6] ?? '';
    if (/Handler$/.test(name) || /^(req|request)$/.test(parameter) || /Request$/.test(type)) return true;
  }
  return false;
}

const isThemeDefinition = (code: string): boolean => /\bcreateTheme\s*\(/.test(code.replace(/^import[^\n]*$/gm, '')) || /^export\s+const\s+\w+\s*:\s*\w*(?:Tokens|Theme|Palette)\s*=/m.test(code);

/** Tags a file's path alone gives (test, mock, story, config): never cached with the content, since copies differ. */
export function pathTags(path: string): FileTag[] {
  const tags: FileTag[] = [];
  if (isTestPath(path)) tags.push('test');
  if (isMockPath(path)) tags.push('mock');
  if (isStoryPath(path)) tags.push('story');
  if (isConfigPath(path)) tags.push('config');
  return tags;
}

/** Whether a file is test material (a test, mock or story), whose own code is not classified. */
export const isTestMaterial = (tags: readonly FileTag[]): boolean => tags.some(tag => tag === 'test' || tag === 'mock' || tag === 'story');

/**
 * Tags of one file by path and code (comments and strings removed): what kind of file it is and what it does. A
 * theme re-export is tagged later, when the files it re-exports are known.
 */
export function classifyFile(params: { path: string; text: string; code: string }): FileTag[] {
  const { path, text, code } = params;
  const byPath = pathTags(path);
  if (code === '' || isTestMaterial(byPath)) return [...byPath].sort();
  return [...new Set([...byPath, ...contentTags({ isJsx: /\.[jt]sx$/.test(path), text, code })])].sort();
}

/**
 * Tags from the content alone, for a file that is not test material: depends only on the bytes and whether the file
 * is JSX (`.tsx`/`.jsx`), so it can be cached by content hash and language.
 */
export function contentTags(params: { isJsx: boolean; text: string; code: string }): FileTag[] {
  const { isJsx, text, code } = params;
  const tags = new Set<FileTag>();
  if (code === '') return [];
  const isComponent = isJsx && declaresComponent(code);
  if (isComponent) tags.add('react-component');
  if (/^export\s+(?:default\s+)?(?:function\s+use[A-Z]\w*|const\s+use[A-Z]\w*\s*=)/m.test(code)) tags.add('hook');
  if (/\bcreateContext\s*\(/.test(code) || (isComponent && /^export\s+(?:default\s+)?(?:function|const)\s+\w*Provider\b/m.test(code))) tags.add('provider');
  if (isThemeDefinition(code)) tags.add('theme-definition');
  // Registrations are found in the text (the path is a string) but only where the code itself has them (not commented out).
  if ([...text.matchAll(/\b\w+\.(?:get|post|put|patch|delete)\(\s*['"]\//g)].some(match => code[match.index ?? 0] !== ' ')) tags.add('api-route');
  const isHandler = declaresHandler(code);
  if (isHandler) tags.add('api-handler');
  if (/\b(?:db|knex|prisma|pool|client|connection)\s*\.\s*(?:query|execute|raw)\s*\(|\.from\(\s*['"]/.test(code)) tags.add('data-access');
  if (/\bz\.object\s*\(|^export\s+(?:interface|type)\s+\w+/m.test(code)) tags.add('schema');
  if (PII_DECLARATION.test(code)) tags.add('personal-data-fields');
  if (isComponent && PII_RENDER.test(code)) tags.add('renders-customer-data');
  if (isHandler) for (const [tag, pattern] of GDPR_RULES) if ((code.match(/[A-Za-z_$][\w$]*/g) ?? []).some(identifier => pattern.test(identifier))) tags.add(tag);
  return [...tags].sort();
}
