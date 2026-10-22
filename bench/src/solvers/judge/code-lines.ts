/** The code part of one line: `//` comments dropped, string contents emptied, block-comment lines blank. */
export function codeOfLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  let out = '';
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? '';
    if (quote != null) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) { quote = undefined; out += char; }
      continue;
    }
    if (char === '/' && line[index + 1] === '/') break;
    if (char === '\'' || char === '"' || char === '`') quote = char;
    out += char;
  }
  return out;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `word` appears as a whole identifier in the line's code (not in a comment or string). */
export function usesInCode(params: { line: string; word: string }): boolean {
  const { line, word } = params;
  return new RegExp(`(?<![\\w$])${escape(word)}(?![\\w$])`).test(codeOfLine(line));
}

/** Whole-word, exact-case occurrence anywhere in a text. */
export function hasWord(params: { text: string; word: string }): boolean {
  return new RegExp(`(?<![\\w$])${escape(params.word)}(?![\\w$])`).test(params.text);
}

/** Every line of a file in code-only form, tracking block comments across lines. */
export function codeLines(text: string): string[] {
  let inBlock = false;
  return text.split('\n').map(line => {
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) return '';
      inBlock = false;
      return codeOfLine(line.slice(end + 2));
    }
    const start = line.indexOf('/*');
    if (start >= 0 && !line.includes('*/', start)) { inBlock = true; return codeOfLine(line.slice(0, start)); }
    return codeOfLine(line);
  });
}
