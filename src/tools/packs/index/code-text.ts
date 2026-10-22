const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

/**
 * The code of a JavaScript/TypeScript source with comments and string contents replaced by spaces (same length, same
 * lines), so pattern checks never match inside a comment or a string. Template `${...}` expressions stay code. Regex
 * literals are not recognised (a `/` inside one may be read as division); that only matters for patterns in them.
 */
export function codeOnly(text: string): string {
  const out: string[] = [];
  const templateDepths: number[] = [];
  let depth = 0;
  let index = 0;
  const readTemplate = (start: number): number => {
    let end = start;
    while (end < text.length && text[end] !== '`' && !(text[end] === '$' && text[end + 1] === '{')) end += text[end] === '\\' ? 2 : 1;
    out.push(blank(text.slice(start, Math.min(end, text.length))));
    if (end >= text.length) return text.length;
    if (text[end] === '`') { out.push('`'); return end + 1; }
    out.push('  ');
    templateDepths.push(depth);
    return end + 2;
  };
  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (char === '/' && (next === '/' || next === '*')) {
      const end = next === '/' ? text.indexOf('\n', index) : text.indexOf('*/', index + 2);
      const stop = end < 0 ? text.length : next === '/' ? end : end + 2;
      out.push(blank(text.slice(index, stop)));
      index = stop;
    } else if (char === '}' && templateDepths.at(-1) === depth) {
      templateDepths.pop();
      out.push(' ');
      index = readTemplate(index + 1);
    } else if (char === '`') {
      out.push('`');
      index = readTemplate(index + 1);
    } else if (char === '\'' || char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== char && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
      const closed = end < text.length && text[end] === char;
      out.push(char, blank(text.slice(index + 1, Math.min(end, text.length))), closed ? char : '');
      index = closed ? end + 1 : end;
    } else {
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      out.push(char);
      index += 1;
    }
  }
  return out.join('');
}

/** Identifier tokens of code text. */
export function identifiersOf(code: string): string[] {
  return [...new Set(code.match(/[A-Za-z_$][\w$]*/g) ?? [])];
}
