import { describe, expect, it } from 'vitest';
import { queryJsonPath } from './json-path.js';

const store = {
  name: 'shop',
  books: [
    { title: 'A', price: 8, tags: ['x'], author: { name: 'Ann' } },
    { title: 'B', price: 12, tags: [], author: { name: 'Bob' } },
    { title: 'C', price: 20, isbn: '123', author: { name: 'Cy' } },
  ],
  'odd key': { 'a.b': 1 },
};

describe('queryJsonPath', () => {
  it.each<[string, unknown[]]>([
    ['$', [store]],
    ['$.name', ['shop']],
    ['$.books[0].title', ['A']],
    ['$.books[-1].title', ['C']],
    ['$.books[*].price', [8, 12, 20]],
    ['$.books.*.title', ['A', 'B', 'C']],
    ['$..name', ['shop', 'Ann', 'Bob', 'Cy']],
    ["$['odd key']['a.b']", [1]],
    ['$.books[?(@.price > 10)].title', ['B', 'C']],
    ['$.books[?(@.price <= 8)].title', ['A']],
    ["$.books[?(@.author.name == 'Bob')].price", [12]],
    ['$.books[?(@.isbn)].title', ['C']],
    ['$.books[?(@.title != "A")].title', ['B', 'C']],
    ['$.missing', []],
    ['$.books[9]', []],
  ])('%s', (query, expected) => {
    expect(queryJsonPath({ document: store, query })).toEqual(expected);
  });

  it.each(['books', '$.', '$[', '$.books[?(@.price ~ 1)]', '$.books[abc]', "$['open", '$..', '$.books[?(@.price > )]'])('rejects %s with its position', query => {
    expect(() => queryJsonPath({ document: store, query })).toThrow(expect.objectContaining({ code: 'invalid_input', details: expect.objectContaining({ reason: 'invalid_query', position: expect.any(Number) }) }));
  });
});
