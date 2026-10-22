import { describe, expect, it } from 'vitest';
import { fitList, itemShareChars, jsonChars, pageOfText } from './web-budget.js';

describe('web result budget', () => {
  it('splits the budget between the items of a call', () => {
    expect(itemShareChars({ maxResultTokens: 1_000, itemCount: 1 })).toBe(3_600);
    expect(itemShareChars({ maxResultTokens: 1_000, itemCount: 4 })).toBe(900);
  });

  it('cuts a page by its escaped size, never inside a surrogate pair, and always moves forward', () => {
    const quoted = '"'.repeat(1_000);
    const page = pageOfText({ text: quoted, offset: 0, maxChars: 1_000, maxJsonChars: 300 });
    expect(jsonChars(page.text)).toBeLessThanOrEqual(300);
    expect(page).toMatchObject({ totalChars: 1_000, nextOffset: page.text.length });
    const emoji = 'a'.repeat(199) + '😀'.repeat(10);
    const cut = pageOfText({ text: emoji, offset: 0, maxChars: 200, maxJsonChars: 200 });
    expect(cut.text).toBe('a'.repeat(199));
    expect(pageOfText({ text: 'abc', offset: 3, maxChars: 10, maxJsonChars: 10 })).toEqual({ text: '', totalChars: 3 });
    expect(pageOfText({ text: 'abc', offset: 1, maxChars: 10, maxJsonChars: 10 })).toEqual({ text: 'bc', totalChars: 3 });
  });

  it('keeps the leading list entries that fit', () => {
    expect(fitList({ list: ['aaaa', 'bbbb', 'cccc'], maxJsonChars: 14 })).toEqual(['aaaa', 'bbbb']);
  });
});
