import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createShaperRegistry, createBuiltinShaperRegistry } from './shaper-registry.js';
import { createShapingState, runShapers } from './run-shapers.js';
import { CONTENT_KINDS } from './shaper-types.js';
import type { ContentKind, Fidelity } from './shaper-types.js';
import { VERBATIM_CORPUS } from './verbatim-corpus.test-support.js';

const CORPUS = Object.entries(VERBATIM_CORPUS);
const BUILTINS = createBuiltinShaperRegistry().list();

/** Every way a corpus file can appear as a tool result: the text itself, or inside a structured result. */
function shapesOf(text: string): unknown[] {
  return [text, { path: 'file', content: text }, [{ content: text }, { content: text }, { content: text }]];
}

function pipeline(params: { value: unknown; kind: ContentKind; fidelity?: Fidelity }): unknown {
  const { value, kind, fidelity } = params;
  return runShapers({
    value, callId: 'c1', state: createShapingState(), registry: createBuiltinShaperRegistry(),
    tool: { name: 'read', contentKind: kind, ...(fidelity == null ? {} : { fidelity }) },
  }).value;
}

describe('verbatim guarantee', () => {
  it.each(CORPUS)('%s: every shaper is a no-op for every kind outside its appliesTo', (_name, text) => {
    for (const shaper of BUILTINS) {
      const registry = createShaperRegistry([shaper]);
      for (const kind of CONTENT_KINDS.filter(contentKind => !shaper.appliesTo.includes(contentKind))) {
        for (const value of shapesOf(text)) {
          const shaped = runShapers({ value, callId: 'c1', state: createShapingState(), registry, tool: { name: 'read', contentKind: kind, fidelity: 'lossy-ok' } });
          expect(JSON.stringify(shaped.value)).toBe(JSON.stringify(value));
          expect(shaped.shaped).toEqual([]);
        }
      }
    }
  });

  it.each(CORPUS)('%s: the full pipeline is byte-identical for verbatim and undeclared fidelity, whatever the kind', (_name, text) => {
    for (const kind of CONTENT_KINDS) {
      for (const value of shapesOf(text)) {
        expect(JSON.stringify(pipeline({ value, kind, fidelity: 'verbatim' }))).toBe(JSON.stringify(value));
        expect(JSON.stringify(pipeline({ value, kind }))).toBe(JSON.stringify(value));
      }
    }
  });

  it.each(CORPUS)('%s: file-content is untouched by the full pipeline even when declared lossy-ok', (_name, text) => {
    for (const value of shapesOf(text)) expect(JSON.stringify(pipeline({ value, kind: 'file-content', fidelity: 'lossy-ok' }))).toBe(JSON.stringify(value));
  });

  it('property: any JSON value labelled verbatim comes out equal', () => {
    fc.assert(fc.property(fc.jsonValue(), fc.constantFrom(...CONTENT_KINDS), (value, kind) => {
      expect(pipeline({ value, kind, fidelity: 'verbatim' })).toEqual(value);
    }));
  });

  it('property: any string labelled verbatim comes out identical', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), fc.constantFrom(...CONTENT_KINDS), (value, kind) => {
      expect(pipeline({ value, kind })).toBe(value);
    }));
  });
});
