import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.js';

describe('parseCsv (RFC 4180)', () => {
  it.each<[string, string, string[][]]>([
    ['plain rows', 'a,b\n1,2\n', [['a', 'b'], ['1', '2']]],
    ['CRLF line ends', 'a,b\r\n1,2\r\n', [['a', 'b'], ['1', '2']]],
    ['no final newline', 'a,b\n1,2', [['a', 'b'], ['1', '2']]],
    ['a BOM', '﻿a,b\n1,2', [['a', 'b'], ['1', '2']]],
    ['quoted fields with commas', '"a,1",b\n', [['a,1', 'b']]],
    ['escaped quotes', '"say ""hi""",x\n', [['say "hi"', 'x']]],
    ['embedded newlines', '"line1\nline2",x\r\ny,z\n', [['line1\nline2', 'x'], ['y', 'z']]],
    ['empty fields', ',,\n', [['', '', '']]],
    ['an empty quoted field', '"",a\n', [['', 'a']]],
    ['blank lines kept as one empty field', 'a\n\nb\n', [['a'], [''], ['b']]],
  ])('parses %s', (_name, text, rows) => {
    expect(parseCsv({ text })).toEqual(rows);
  });

  it('reports an unterminated quote and text after a closing quote with their line and column', () => {
    expect(() => parseCsv({ text: 'a,"open\nmore' })).toThrow(expect.objectContaining({ code: 'invalid_input', details: expect.objectContaining({ reason: 'unterminated_quote', line: 1, column: 3 }) }));
    expect(() => parseCsv({ text: 'a\n"x"y,z' })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'text_after_quote', line: 2, column: 4 }) }));
  });

  it('property: quoting any fields and parsing gives them back', () => {
    const field = fc.string({ unit: fc.constantFrom('a', 'b', ',', '"', '\n', '\r\n', ' ') });
    fc.assert(fc.property(fc.array(fc.array(field, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 5 }), rows => {
      const text = rows.map(row => row.map(value => `"${value.replace(/"/g, '""')}"`).join(',')).join('\r\n');
      expect(parseCsv({ text })).toEqual(rows);
    }));
  });
});
