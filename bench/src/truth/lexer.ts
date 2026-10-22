/** A string literal's position in the original text and its raw content (between the quotes). */
export interface StringSpan {
  start: number;
  end: number;
  value: string;
}

/** Source with comments and string contents blanked (same length, newlines kept), plus the strings it held. */
export interface ScannedSource {
  code: string;
  strings: StringSpan[];
}

const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

/**
 * Splits TypeScript/JavaScript into code and non-code: `//` and `/* *\/` comments and the contents of `'`, `"` and
 * template literals are replaced by spaces (template `${...}` expressions stay code). Positions and line numbers are
 * unchanged, so a match in `code` has the same line as in the original. Regex literals are not recognised (the
 * generated repositories contain none).
 */
export function scanSource(text: string): ScannedSource {
  const out: string[] = [];
  const strings: StringSpan[] = [];
  let index = 0;
  const templateDepths: number[] = [];
  let braceDepth = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      const stop = end < 0 ? text.length : end;
      out.push(blank(text.slice(index, stop)));
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end < 0 ? text.length : end + 2;
      out.push(blank(text.slice(index, stop)));
      index = stop;
      continue;
    }
    if (char === '}' && templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === braceDepth) {
      templateDepths.pop();
      out.push(' ');
      index = readTemplate({ text, start: index + 1, out, strings, templateDepths, braceDepth });
      continue;
    }
    if (char === '`') {
      out.push(char);
      index = readTemplate({ text, start: index + 1, out, strings, templateDepths, braceDepth });
      continue;
    }
    if (char === '\'' || char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== char && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
      strings.push({ start: index + 1, end, value: text.slice(index + 1, end) });
      out.push(char, blank(text.slice(index + 1, end)), end < text.length && text[end] === char ? char : '');
      index = end < text.length && text[end] === char ? end + 1 : end;
      continue;
    }
    if (char === '{') braceDepth += 1;
    if (char === '}') braceDepth -= 1;
    out.push(char);
    index += 1;
  }
  return { code: out.join(''), strings };
}

/** Reads template text from `start` up to the closing backtick or a `${` (whose expression is code); returns the next index. */
function readTemplate(params: { text: string; start: number; out: string[]; strings: StringSpan[]; templateDepths: number[]; braceDepth: number }): number {
  const { text, start, out, strings, templateDepths, braceDepth } = params;
  let end = start;
  while (end < text.length && text[end] !== '`' && !(text[end] === '$' && text[end + 1] === '{')) end += text[end] === '\\' ? 2 : 1;
  strings.push({ start, end, value: text.slice(start, end) });
  out.push(blank(text.slice(start, end)));
  if (end >= text.length) return end;
  if (text[end] === '`') { out.push('`'); return end + 1; }
  // The `${` and its closing `}` are template syntax, not code: blanked like the text around them.
  out.push('  ');
  // The expression ends at the first `}` seen at this brace depth (its own inner braces open and close around it).
  templateDepths.push(braceDepth);
  return end + 2;
}

/** Identifier-like tokens of code text (comments and strings already blanked). */
export function codeIdentifiers(code: string): Set<string> {
  return new Set(code.match(/[A-Za-z_$][\w$]*/g) ?? []);
}

/** The 1-based line of a character offset. */
export function lineOf(params: { text: string; offset: number }): number {
  const { text, offset } = params;
  let line = 1;
  for (let position = 0; position < offset && position < text.length; position += 1) if (text[position] === '\n') line += 1;
  return line;
}
