/** Whitespace PCRE's extended mode ignores outside character classes. */
const EXTENDED_WHITESPACE = /\s/;
const COMMENT_START = '#';
const NEWLINE = '\n';

/**
 * A pattern written for MongoDB's `x` option, as the pattern the engine actually runs: unescaped whitespace and
 * `#` comments outside character classes removed. Escapes (`\ `, `\#`) and classes are kept as written, so the
 * result means the same without `x` and the shape scan sees the atoms that really sit next to each other.
 */
export function stripExtendedSyntax(pattern: string): string {
  let result = '';
  let isInClass = false;
  for (let at = 0; at < pattern.length; at += 1) {
    const character = pattern[at] ?? '';
    if (character === '\\') {
      result += pattern.slice(at, at + 2);
      at += 1;
      continue;
    }
    if (isInClass) {
      if (character === ']') isInClass = false;
      result += character;
      continue;
    }
    if (character === '[') {
      isInClass = true;
      result += character;
      continue;
    }
    if (character === COMMENT_START) {
      const lineEnd = pattern.indexOf(NEWLINE, at);
      at = lineEnd === -1 ? pattern.length : lineEnd;
      continue;
    }
    if (EXTENDED_WHITESPACE.test(character)) continue;
    result += character;
  }
  return result;
}
