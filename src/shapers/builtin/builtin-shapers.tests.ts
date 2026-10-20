import { describe, expect, it } from 'vitest';
import { createAliasTable } from '../alias-table.js';
import type { ContentKind, Shaper, ShaperContext } from '../shaper-types.js';
import { aliasesShaper } from './aliases.js';
import { dedupeReadsShaper } from './dedupe-reads.js';
import { foldRepeatsShaper } from './fold-repeats.js';
import { htmlBoilerplateShaper } from './html-boilerplate.js';
import { stripNoiseShaper } from './strip-noise.js';
import { decodeTabular, tabularShaper } from './tabular.js';

function context(overrides: Partial<ShaperContext> = {}): ShaperContext {
  return { callId: 'c2', tool: 't', originalHandle: () => 'H1', aliases: createAliasTable({ minLength: 24 }), ...overrides };
}

function shape(params: { shaper: Shaper; value: unknown; kind: ContentKind; context?: ShaperContext }) {
  const { shaper, value, kind } = params;
  return shaper.shape({ value, kind, text: typeof value === 'string' ? value : JSON.stringify(value), context: params.context ?? context() });
}

describe('tabular', () => {
  const rows = [{ id: 1, name: 'Ann', score: null }, { name: 'Bob', id: 2, score: 3 }, { id: 3, name: 'Cy', score: '' }];

  it('turns three or more homogeneous flat objects into columns and rows, losslessly', () => {
    const shaped = shape({ shaper: tabularShaper, value: rows, kind: 'structured-data' });
    expect(shaped?.value).toEqual({ columns: ['id', 'name', 'score'], rows: [[1, 'Ann', null], [2, 'Bob', 3], [3, 'Cy', '']] });
    expect(shaped?.note).toContain('handle H1');
    expect(decodeTabular(shaped?.value as Parameters<typeof decodeTabular>[0])).toEqual(rows);
  });

  it('leaves fewer than three rows, mixed shapes and nested values alone', () => {
    expect(shape({ shaper: tabularShaper, value: rows.slice(0, 2), kind: 'structured-data' })).toBeUndefined();
    expect(shape({ shaper: tabularShaper, value: [...rows.slice(0, 2), { id: 3 }], kind: 'structured-data' })).toBeUndefined();
    expect(shape({ shaper: tabularShaper, value: [...rows.slice(0, 2), { id: 3, name: 'x', score: { deep: 1 } }], kind: 'structured-data' })).toBeUndefined();
    expect(shape({ shaper: tabularShaper, value: 'id,name', kind: 'structured-data' })).toBeUndefined();
  });
});

describe('strip-noise', () => {
  it('removes ANSI escapes, progress overwrites, trailing whitespace and extra blank lines', () => {
    const output = '\u001b[32mok\u001b[0m   \r\n10%\r50%\r100%\nnext\t\n\n\n\n\nend';
    const shaped = shape({ shaper: stripNoiseShaper, value: output, kind: 'command-output' });
    expect(shaped?.value).toBe('ok\n100%\nnext\n\n\nend');
    expect(shaped?.note).toContain('handle H1');
  });

  it('does nothing to clean output or non-text results', () => {
    expect(shape({ shaper: stripNoiseShaper, value: 'clean\noutput', kind: 'command-output' })).toBeUndefined();
    expect(shape({ shaper: stripNoiseShaper, value: { a: 1 }, kind: 'command-output' })).toBeUndefined();
  });
});

describe('fold-repeats', () => {
  it('folds three or more identical consecutive lines with the exact count', () => {
    const log = ['start', ...Array.from({ length: 37 }, () => 'retrying'), 'x', 'x', 'end'].join('\n');
    expect(shape({ shaper: foldRepeatsShaper, value: log, kind: 'log' })?.value).toBe('start\nretrying (x37)\nx\nx\nend');
  });

  it('does nothing without a run of three', () => {
    expect(shape({ shaper: foldRepeatsShaper, value: 'a\na\nb', kind: 'log' })).toBeUndefined();
  });
});

describe('html-boilerplate', () => {
  it('removes scripts, styles, navigation, footers, asides and comments and keeps the main text', () => {
    const page = '<html><head><STYLE>b{}</STYLE><script src="x"></script></head><body><nav>Menu</nav>\n\n  <main><h1>Title</h1>   <p>Main text</p></main><!-- c --><aside>ad</aside><footer>(c)</footer></body></html>';
    const shaped = shape({ shaper: htmlBoilerplateShaper, value: page, kind: 'web-page' });
    expect(shaped?.value).toBe('<html><head></head><body>\n<main><h1>Title</h1> <p>Main text</p></main></body></html>');
    expect(shaped?.note).toBe('HTML boilerplate removed (scripts, styles, navigation, footers, asides, comments); full page: handle H1');
  });
});

describe('dedupe-reads', () => {
  it('replaces a result identical to an earlier call\'s with a stub naming that call', () => {
    const shaped = shape({ shaper: dedupeReadsShaper, value: { hits: [1, 2] }, kind: 'search-hits', context: context({ previousIdenticalCall: 'c1' }) });
    expect(shaped).toEqual({ value: 'Same as call c1 (unchanged)', note: 'Identical to the result of call c1; full result: handle H1' });
  });

  it('does nothing for a first result', () => {
    expect(shape({ shaper: dedupeReadsShaper, value: { hits: [1, 2] }, kind: 'search-hits' })).toBeUndefined();
  });
});

describe('aliases', () => {
  const long = 'src/components/theme/ThemeProvider.tsx';

  it('aliases long strings repeated in a result and lists the legend in the note', () => {
    const shapingContext = context();
    const shaped = shape({ shaper: aliasesShaper, value: { hits: [{ path: long, line: 1 }, { path: long, line: 9 }, { path: 'short' }] }, kind: 'search-hits', context: shapingContext });
    expect(shaped?.value).toEqual({ hits: [{ path: 'F1', line: 1 }, { path: 'F1', line: 9 }, { path: 'short' }] });
    expect(shaped?.note).toBe(`Aliases (usable as a whole argument value for tools that accept aliases): F1 = ${JSON.stringify(long)}`);
    expect(shapingContext.aliases.valueOf('F1')).toBe(long);
  });

  it('reuses aliases from earlier results and ignores long strings seen once', () => {
    const shapingContext = context();
    shapingContext.aliases.aliasFor(long);
    expect(shape({ shaper: aliasesShaper, value: [long], kind: 'structured-data', context: shapingContext })?.value).toEqual(['F1']);
    expect(shape({ shaper: aliasesShaper, value: ['a-different-but-long-string-here'], kind: 'structured-data', context: shapingContext })).toBeUndefined();
  });
});

describe('built-in appliesTo', () => {
  it('never lists file-content or binary-ref, so file bytes are never shaped', () => {
    for (const shaper of [tabularShaper, stripNoiseShaper, foldRepeatsShaper, htmlBoilerplateShaper, dedupeReadsShaper, aliasesShaper]) {
      expect(shaper.appliesTo.length).toBeGreaterThan(0);
      expect(shaper.appliesTo).not.toContain('file-content');
      expect(shaper.appliesTo).not.toContain('binary-ref');
    }
    expect(htmlBoilerplateShaper.appliesTo).toEqual(['web-page']);
  });
});
