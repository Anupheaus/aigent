import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createChunker } from './chunker.js';
import type { ChunkPiece } from './knowledge-types.js';

const TARGET = 200;
const OVERLAP = 40;
const chunk = createChunker({ targetChars: TARGET, overlapChars: OVERLAP });

const word = fc.stringMatching(/^[a-z]{1,9}$/);
const sentence = fc.array(word, { minLength: 2, maxLength: 14 }).map(words => `${words.join(' ')}.`);
const paragraph = fc.array(sentence, { minLength: 1, maxLength: 6 }).map(sentences => sentences.join(' '));
const markdown = fc.array(fc.oneof(paragraph, word.map(title => `## ${title}`), fc.array(word, { maxLength: 30 }).map(words => `\`\`\`\n${words.join('\n')}\n\`\`\``)), { maxLength: 14 }).map(blocks => blocks.join('\n\n'));
const anyText = fc.oneof(markdown, fc.string({ maxLength: 900 }));

function checkInvariants(params: { text: string; pieces: ChunkPiece[] }): void {
  const { text, pieces } = params;
  const covered = new Uint8Array(text.length);
  pieces.forEach((piece, index) => {
    expect(piece.end).toBeGreaterThan(piece.start);
    expect(text.slice(piece.start, piece.end).trim()).not.toBe('');
    covered.fill(1, piece.start, piece.end);
    const previous = pieces[index - 1];
    if (previous == null) return;
    expect(piece.start).toBeGreaterThan(previous.start);
    expect(piece.start).toBeGreaterThanOrEqual(previous.end - OVERLAP);
  });
  // Every non-whitespace character is in some chunk.
  for (let at = 0; at < text.length; at += 1) if (!/\s/.test(text[at] ?? '')) expect(covered[at]).toBe(1);
}

describe('createChunker', () => {
  it('covers every non-whitespace character, never yields empty chunks, and overlaps by at most the overlap', () => {
    fc.assert(fc.property(anyText, fc.constantFrom('doc.md', 'notes.txt', 'main.ts'), (text, uri) => {
      checkInvariants({ text, pieces: chunk({ text, uri }) });
    }), { numRuns: 300 });
  });

  it('is stable: the same text gives the same spans', () => {
    fc.assert(fc.property(markdown, text => {
      expect(chunk({ text, uri: 'a.md' })).toEqual(chunk({ text, uri: 'a.md' }));
    }), { numRuns: 100 });
  });

  it('keeps chunks near the target size outside fenced blocks', () => {
    fc.assert(fc.property(fc.array(paragraph, { minLength: 1, maxLength: 12 }).map(paragraphs => paragraphs.join('\n\n')), text => {
      for (const piece of chunk({ text, uri: 'a.txt' })) expect(piece.end - piece.start).toBeLessThanOrEqual(TARGET);
    }), { numRuns: 100 });
  });

  it('never splits inside a fenced code block up to twice the target', () => {
    const fence = `\`\`\`ts\n${Array.from({ length: 15 }, (_, index) => `const value${index} = ${index};`).join('\n')}\n\`\`\``;
    expect(fence.length).toBeGreaterThan(TARGET);
    expect(fence.length).toBeLessThanOrEqual(TARGET * 2);
    const text = `# Intro\n\nSome words before the code block, enough to matter.\n\n${fence}\n\nAnd a closing paragraph after it.`;
    const fenceStart = text.indexOf('```');
    const fenceEnd = text.lastIndexOf('```') + 3;
    const pieces = chunk({ text, uri: 'guide.md' });
    for (const piece of pieces) {
      expect(piece.end <= fenceStart + 1 || piece.end >= fenceEnd).toBe(true);
      expect(piece.start <= fenceStart || piece.start >= fenceEnd).toBe(true);
    }
    expect(pieces.some(piece => piece.start <= fenceStart && piece.end >= fenceEnd)).toBe(true);
  });

  it('splits a fenced block longer than twice the target', () => {
    const fence = `\`\`\`\n${Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n')}\n\`\`\``;
    const pieces = chunk({ text: fence, uri: 'big.md' });
    expect(pieces.length).toBeGreaterThan(2);
  });

  it('records the markdown heading path in metadata and line numbers', () => {
    const text = `# Guide\n\nIntro text.\n\n## Install\n\n${'Run the installer and wait. '.repeat(10)}\n\n## Usage\n\n${'Call the function with options. '.repeat(10)}`;
    const pieces = chunk({ text, uri: 'guide.md' });
    expect(pieces.map(({ metadata }) => metadata?.section)).toContain('Guide > Install');
    expect(pieces.map(({ metadata }) => metadata?.section)).toContain('Guide > Usage');
    expect(pieces[0]).toMatchObject({ startLine: 1, metadata: { section: 'Guide', kind: 'markdown' } });
  });

  it('finds headings in CRLF markdown as in LF markdown (review I4)', () => {
    const text = `# Guide\n\nIntro text.\n\n## Install\n\n${'Run the installer and wait. '.repeat(10)}\n\n## Usage\n\n${'Call the function with options. '.repeat(10)}`;
    const sections = (source: string): unknown[] => chunk({ text: source, uri: 'guide.md' }).map(({ metadata }) => metadata?.section);
    const crlf = sections(text.replace(/\n/g, '\r\n'));
    expect(crlf).toContain('Guide > Install');
    expect(crlf).toEqual(sections(text));
  });

  it('ignores heading-like lines inside fenced blocks (review M1)', () => {
    const text = `# Guide\n\nIntro text.\n\n\`\`\`sh\n# install the tool\nnpm install\n\`\`\`\n\n${'More words after the fence. '.repeat(12)}`;
    const sections = chunk({ text, uri: 'guide.md' }).map(({ metadata }) => metadata?.section);
    expect(sections.every(section => section === 'Guide')).toBe(true);
  });

  it('splits code at top-level declarations', () => {
    const fn = (name: string) => `export function ${name}(input: string): string {\n  const trimmed = input.trim();\n  return trimmed.toUpperCase() + '${name}';\n}\n`;
    const text = ['alpha', 'beta', 'gamma', 'delta'].map(fn).join('\n');
    const pieces = chunk({ text, uri: 'lib.ts' });
    for (const piece of pieces) expect(text.slice(piece.start, piece.end)).toMatch(/^export function/);
  });
});
