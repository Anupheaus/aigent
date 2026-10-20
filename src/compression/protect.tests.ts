import { describe, expect, it } from 'vitest';
import { findProtectedRanges, findProtectedSpans } from './protect.js';

describe('findProtectedSpans', () => {
  it.each([
    ['negations and modals', 'You must not delete files and never push; only read. Do not guess, you cannot and shall not.', ['must', 'not', 'never', 'only', 'not', 'cannot', 'shall', 'not']],
    ['numbers with units', 'Wait 250 ms, keep 3.5 GB free and retry 4 times at 20%.', ['250 ms', '3.5 GB', '4', '20%']],
    ['file paths', 'Edit src/core/run-task.ts and C:\\repo\\a.json, then ./scripts/clean.mjs.', ['src/core/run-task.ts', 'C:\\repo\\a.json', './scripts/clean.mjs']],
    ['identifiers', 'Call createAigent with max_tool_calls and a ToolRegistry, not DEFAULT_LIMITS.', ['createAigent', 'max_tool_calls', 'ToolRegistry', 'not', 'DEFAULT_LIMITS']],
    ['quoted strings', 'Reply "yes please" or say \'stop now\' but it\'s fine.', ['"yes please"', '\'stop now\'']],
    ['urls', 'See https://example.com/docs?a=1 for more.', ['https://example.com/docs?a=1']],
    ['code spans and fences', 'Run `npm test` then:\n```ts\nconst a = 1;\n```\ndone', ['`npm test`', '```ts\nconst a = 1;\n```']],
    ['json objects', 'Send {"id": 1, "ok": true} as the body.', ['{"id": 1, "ok": true}']],
    ['directive lines', 'Report with\n::aigent outcome {"success":true}\nat the end.', ['::aigent outcome {"success":true}']],
  ])('finds %s', (_name, text, spans) => {
    expect(findProtectedSpans(text)).toEqual(spans);
  });

  it('merges overlapping matches into the outermost span, in text order', () => {
    const text = 'Use `createAigent(3)` at /tmp/x.ts';
    expect(findProtectedRanges(text).map(({ start, end }) => text.slice(start, end))).toEqual(['`createAigent(3)`', '/tmp/x.ts']);
  });

  it('finds nothing in plain prose', () => {
    expect(findProtectedSpans('The quick brown fox jumps over the lazy dog')).toEqual([]);
  });
});
