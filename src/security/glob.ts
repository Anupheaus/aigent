/** Characters with a meaning in a regular expression, escaped when they appear literally in a glob. */
const REGEX_SPECIALS = /[.+^$()|\\/[\]{}]/;

function escapeChar(char: string): string {
  return REGEX_SPECIALS.test(char) ? `\\${char}` : char;
}

/** `[abc]`, `[a-z]`, `[!abc]`: a character class that never matches the separator. */
function classAt(params: { pattern: string; start: number }): { source: string; end: number } | undefined {
  const { pattern, start } = params;
  const close = pattern.indexOf(']', start + 2);
  if (close === -1) return undefined;
  const body = pattern.slice(start + 1, close);
  const isNegated = body.startsWith('!') || body.startsWith('^');
  const members = (isNegated ? body.slice(1) : body).replace(/[\\\]^]/g, member => `\\${member}`);
  return { source: isNegated ? `[^/${members}]` : `[${members}]`, end: close + 1 };
}

/** `{a,b}`: alternatives, each a glob of its own (no nesting). */
function braceAt(params: { pattern: string; start: number }): { source: string; end: number } | undefined {
  const { pattern, start } = params;
  const close = pattern.indexOf('}', start);
  if (close === -1) return undefined;
  const options = pattern.slice(start + 1, close).split(',');
  return { source: `(?:${options.map(option => globSource(option)).join('|')})`, end: close + 1 };
}

/** The regular-expression source of one glob (`**`, `*`, `?`, classes and braces; `/` separates segments). */
function globSource(pattern: string): string {
  let source = '';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] ?? '';
    if (char === '*' && pattern[index + 1] === '*') {
      const isWholeSegment = (index === 0 || pattern[index - 1] === '/') && (index + 2 === pattern.length || pattern[index + 2] === '/');
      if (isWholeSegment) {
        // `**/` matches zero or more whole segments; a trailing `**` matches everything below.
        const hasSlash = pattern[index + 2] === '/';
        source += hasSlash ? '(?:[^/]*/)*' : '.*';
        index += hasSlash ? 3 : 2;
        continue;
      }
      source += '[^/]*';
      index += 2;
      continue;
    }
    if (char === '*') { source += '[^/]*'; index += 1; continue; }
    if (char === '?') { source += '[^/]'; index += 1; continue; }
    const special = char === '[' ? classAt({ pattern, start: index }) : char === '{' ? braceAt({ pattern, start: index }) : undefined;
    if (special != null) { source += special.source; index = special.end; continue; }
    source += escapeChar(char);
    index += 1;
  }
  return source;
}

const compiled = new Map<string, RegExp>();

/** Compiles a glob once per pattern and case mode. */
export function globRegExp(params: { pattern: string; caseSensitive?: boolean }): RegExp {
  const { pattern, caseSensitive = true } = params;
  const key = `${caseSensitive ? 's' : 'i'}:${pattern}`;
  const existing = compiled.get(key);
  if (existing != null) return existing;
  const regex = new RegExp(`^${globSource(pattern)}$`, caseSensitive ? 'u' : 'iu');
  compiled.set(key, regex);
  return regex;
}

/**
 * Whether `path` (segments separated by `/`, relative or absolute) matches the glob, case-sensitively: `**` (any
 * number of whole segments), `*` and `?` (within one segment), `[abc]` / `[a-z]` / `[!a]` and `{a,b}`. Use
 * `globRegExp({ pattern, caseSensitive: false })` for case-insensitive file systems.
 */
export function matchGlob(pattern: string, path: string): boolean {
  return globRegExp({ pattern }).test(path);
}
