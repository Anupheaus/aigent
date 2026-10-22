import { describe, expect, it } from 'vitest';
import { codeIdentifiers, lineOf, scanSource } from './lexer.js';

describe('scanSource', () => {
  it('blanks comments and string contents, keeping length and lines', () => {
    const text = "const a = 'x y'; // note b\n/* c\n d */ const e = \"f\";\n";
    const { code, strings } = scanSource(text);
    expect(code).toHaveLength(text.length);
    expect(code.split('\n')).toHaveLength(text.split('\n').length);
    expect([...codeIdentifiers(code)].sort()).toEqual(['a', 'const', 'e']);
    expect(strings.map(({ value }) => value)).toEqual(['x y', 'f']);
  });

  it('keeps template expressions as code, including nested braces', () => {
    const { code } = scanSource('const t = `a ${record.total} b ${fn({ k: 1 })} c` + tail;');
    expect([...codeIdentifiers(code)].sort()).toEqual(['const', 'fn', 'k', 'record', 't', 'tail', 'total']);
  });

  it('handles escapes and quotes inside comments', () => {
    const { code } = scanSource("// don't stop\nconst s = 'it\\'s'; const z = 1;");
    expect([...codeIdentifiers(code)].sort()).toEqual(['const', 's', 'z']);
  });

  it('reports 1-based lines of offsets', () => {
    expect(lineOf({ text: 'a\nb\nc', offset: 4 })).toBe(3);
    expect(lineOf({ text: 'a\nb', offset: 0 })).toBe(1);
  });
});
