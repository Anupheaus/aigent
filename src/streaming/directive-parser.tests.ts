import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createDirectiveParser } from './directive-parser.js';
import type { Directive } from './directive-parser.js';

interface Collected { text: string; directives: Directive[]; warnings: string[] }

function parseInChunks(chunks: string[]): Collected {
  const parser = createDirectiveParser();
  const collected: Collected = { text: '', directives: [], warnings: [] };
  for (const output of [...chunks.map(chunk => parser.push(chunk)), parser.end()]) {
    collected.text += output.text;
    collected.directives.push(...output.directives);
    collected.warnings.push(...output.warnings);
  }
  return collected;
}

const SAMPLE = 'Hello\n::aigent outcome {"success":true,"answer":"c:\\\\a.ts"}\nMore text\n::aigent status {"text":"Checking"}\nend';

describe('createDirectiveParser', () => {
  it('passes plain text through unchanged', () => {
    expect(parseInChunks(['just text\nmore'])).toEqual({ text: 'just text\nmore', directives: [], warnings: [] });
  });

  it('extracts directives and strips their lines', () => {
    const result = parseInChunks([SAMPLE]);
    expect(result.text).toBe('Hello\nMore text\nend');
    expect(result.directives).toEqual([
      { type: 'outcome', data: { success: true, answer: 'c:\\a.ts' } },
      { type: 'status', data: { text: 'Checking' } },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('gives the same result for every possible two-way split of the stream', () => {
    const expected = parseInChunks([SAMPLE]);
    for (let splitAt = 0; splitAt <= SAMPLE.length; splitAt += 1) {
      expect(parseInChunks([SAMPLE.slice(0, splitAt), SAMPLE.slice(splitAt)])).toEqual(expected);
    }
  });

  it('gives the same result for arbitrary chunkings (property)', () => {
    const expected = parseInChunks([SAMPLE]);
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 60 }), sizes => {
      const chunks: string[] = [];
      let offset = 0;
      for (const size of sizes) { chunks.push(SAMPLE.slice(offset, offset + size)); offset += size; }
      chunks.push(SAMPLE.slice(offset));
      expect(parseInChunks(chunks)).toEqual(expected);
    }));
  });

  it('only recognises directives at the start of a line', () => {
    const result = parseInChunks(['see ::aigent status {"text":"x"} here\n']);
    expect(result.text).toBe('see ::aigent status {"text":"x"} here\n');
    expect(result.directives).toEqual([]);
  });

  it('warns on malformed json, unknown types and schema violations, never showing the line', () => {
    const result = parseInChunks(['::aigent status {oops}\n::aigent nonsense {}\n::aigent outcome {"success":"yes"}\nkept\n']);
    expect(result.text).toBe('kept\n');
    expect(result.directives).toEqual([]);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toMatch(/status/);
    expect(result.warnings[1]).toMatch(/nonsense/);
    expect(result.warnings[2]).toMatch(/outcome/);
  });

  const markerLookalikes = ['::aigentic agents are cool\n', '::aigents\n', '::aigent_status {"text":"x"}\n', '::aigentic'];

  it.each(markerLookalikes)('keeps a line that only starts like the marker as visible text: %j', line => {
    const expected = { text: line, directives: [], warnings: [] };
    expect(parseInChunks([line])).toEqual(expected);
    for (let splitAt = 0; splitAt <= line.length; splitAt += 1) {
      expect(parseInChunks([line.slice(0, splitAt), line.slice(splitAt)])).toEqual(expected);
    }
  });

  it('still recognises the marker followed by a tab or at the end of the line', () => {
    expect(parseInChunks(['::aigent\tstatus {"text":"tabbed"}\n']).directives).toEqual([{ type: 'status', data: { text: 'tabbed' } }]);
    const bare = parseInChunks(['::aigent\nafter']);
    expect(bare.text).toBe('after');
    expect(bare.warnings).toEqual([expect.stringContaining("directive type ''")]);
  });

  it('does not lose or leak partial prefixes at end of stream', () => {
    expect(parseInChunks(['text\n::ai']).text).toBe('text\n::ai');
    expect(parseInChunks(['text\n:']).text).toBe('text\n:');
    expect(parseInChunks(['::aigent status {"text":"last"}']).directives).toHaveLength(1);
  });

  it('holds a possible prefix back until it can decide, emitting nothing early', () => {
    const parser = createDirectiveParser();
    expect(parser.push('::aig')).toEqual({ text: '', directives: [], warnings: [] });
    expect(parser.push('ent status {"text":"a"}\n').directives).toHaveLength(1);
  });

  it('flushes a held non-directive prefix once it diverges', () => {
    const parser = createDirectiveParser();
    expect(parser.push('::a').text).toBe('');
    expect(parser.push('bc\n').text).toBe('::abc\n');
  });
});
