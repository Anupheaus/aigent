import { describe, expect, it } from 'vitest';
import { MAX_SNIPPET_CHARS, snippetFor } from './snippet.js';

describe('snippetFor', () => {
  it('returns text that fits whole', () => {
    expect(snippetFor({ text: '  Short text.  ', query: 'text' })).toBe('Short text.');
  });

  it('cuts a sentence longer than the limit around the first query term, not at its start (review M2)', () => {
    const words = Array.from({ length: 200 }, (_, index) => `word${index}`);
    words[150] = 'zebra';
    const text = `${words.join(' ')}.`;
    const snippet = snippetFor({ text, query: 'zebra' });
    expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    expect(snippet).toContain('zebra');
    // Centred: there is context on both sides of the term.
    expect(snippet.indexOf('zebra')).toBeGreaterThan(MAX_SNIPPET_CHARS / 4);
  });

  it('picks the sentence with the most query terms', () => {
    const filler = 'Nothing to see in this sentence at all. '.repeat(12);
    const text = `${filler}The zebra crossed the road. ${filler}`;
    expect(snippetFor({ text, query: 'zebra road' })).toContain('The zebra crossed the road.');
  });
});
