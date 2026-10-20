import { describe, expect, it } from 'vitest';
import { createShaperRegistry, createBuiltinShaperRegistry } from './shaper-registry.js';
import { createShapingState, runShapers } from './run-shapers.js';
import type { RunShapersParams } from './run-shapers.js';
import type { Shaper } from './shaper-types.js';

const NOISY = '\u001b[31mfail\u001b[0m\nretry\nretry\nretry\nretry   ';

function run(overrides: Partial<RunShapersParams> & Pick<RunShapersParams, 'value'>) {
  return runShapers({
    tool: { name: 'sh', contentKind: 'command-output', fidelity: 'lossy-ok' }, callId: 'c1', state: createShapingState(), registry: createBuiltinShaperRegistry(),
    ...overrides,
  });
}

describe('runShapers', () => {
  it('runs every applicable shaper in order, wraps the result with notes and one handle to the original', () => {
    const state = createShapingState();
    const shaped = run({ value: NOISY, state });
    expect(shaped.value).toEqual({
      result: 'fail\nretry (x4)',
      shaping: [
        { shaper: 'strip-noise', note: expect.stringContaining('handle H1'), handle: 'H1' },
        { shaper: 'fold-repeats', note: expect.stringContaining('handle H1'), handle: 'H1' },
      ],
    });
    expect(state.originals.get('H1')).toBe(NOISY);
    expect(shaped.shaped).toEqual([
      { shaper: 'strip-noise', tokensBefore: Math.ceil(NOISY.length / 4), tokensAfter: Math.ceil('fail\nretry\nretry\nretry\nretry'.length / 4) },
      { shaper: 'fold-repeats', tokensBefore: Math.ceil('fail\nretry\nretry\nretry\nretry'.length / 4), tokensAfter: Math.ceil('fail\nretry (x4)'.length / 4) },
    ]);
  });

  it('never throws: a result canonical JSON cannot hash and a throwing shaper are both left unshaped', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const structured = { name: 'q', contentKind: 'structured-data', fidelity: 'lossy-ok' } as const;
    expect(run({ value: cyclic, tool: structured })).toEqual({ value: cyclic, shaped: [] });
    expect(run({ value: { total: BigInt(3) }, tool: structured })).toEqual({ value: { total: BigInt(3) }, shaped: [] });
    const registry = createShaperRegistry([{ name: 'broken', appliesTo: ['command-output'], shape: () => { throw new Error('broken shaper'); } }]);
    expect(run({ value: NOISY, registry })).toEqual({ value: NOISY, shaped: [] });
  });

  it('returns verbatim and undeclared-fidelity results untouched', () => {
    const verbatim = run({ value: NOISY, tool: { name: 'sh', contentKind: 'command-output', fidelity: 'verbatim' } });
    const undeclared = run({ value: NOISY, tool: { name: 'sh', contentKind: 'command-output' } as RunShapersParams['tool'] });
    expect(verbatim).toEqual({ value: NOISY, shaped: [] });
    expect(undeclared).toEqual({ value: NOISY, shaped: [] });
  });

  it('honours shapers: off and an allow list', () => {
    expect(run({ value: NOISY, settings: 'off' })).toEqual({ value: NOISY, shaped: [] });
    const allowed = run({ value: NOISY, settings: { allow: ['fold-repeats'] } });
    expect(allowed.shaped.map(({ shaper }) => shaper)).toEqual(['fold-repeats']);
  });

  it('leaves results of kinds no shaper applies to untouched and allocates no handle', () => {
    const state = createShapingState();
    expect(run({ value: NOISY, state, tool: { name: 'read', contentKind: 'file-content', fidelity: 'lossy-ok' } })).toEqual({ value: NOISY, shaped: [] });
    expect(state.originals.handles()).toEqual([]);
  });

  it('numbers handles per run and stubs a repeated identical result with the earlier call id', () => {
    const state = createShapingState();
    const tool = { name: 'search', contentKind: 'search-hits' as const, fidelity: 'lossy-ok' as const };
    const hits = { hits: ['a', 'b'] };
    expect(run({ value: hits, tool, state, callId: 'c1' })).toEqual({ value: hits, shaped: [] });
    const repeat = run({ value: structuredClone(hits), tool, state, callId: 'c2' });
    expect(repeat.value).toEqual({ result: 'Same as call c1 (unchanged)', shaping: [{ shaper: 'dedupe-reads', note: 'Identical to the result of call c1; full result: handle H1', handle: 'H1' }] });
    expect(state.originals.get('H1')).toBe(JSON.stringify(hits));
  });

  it('records a shaper that made the result larger, for the net-negative finding', () => {
    const growing: Shaper = { name: 'grow', appliesTo: ['prose'], shape: ({ text }) => ({ value: `${text} and more and more`, note: 'grown' }) };
    const shaped = run({ value: 'tiny', tool: { name: 'p', contentKind: 'prose', fidelity: 'lossy-ok' }, registry: createShaperRegistry([growing]) });
    expect(shaped.shaped).toEqual([{ shaper: 'grow', tokensBefore: 1, tokensAfter: 6 }]);
  });
});

describe('shaper registry', () => {
  it('rejects a shaper without appliesTo, or with an empty one, or with a duplicate name', () => {
    const missing = { name: 'x', shape: () => undefined } as unknown as Shaper;
    expect(() => createShaperRegistry([missing])).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringContaining("Shaper 'x'") }));
    expect(() => createShaperRegistry([{ name: 'y', appliesTo: [], shape: () => undefined }])).toThrow(/appliesTo/);
    const registry = createShaperRegistry([]);
    expect(() => registry.registerShaper({ name: 'z', appliesTo: ['bogus' as 'prose'], shape: () => undefined })).toThrow(/bogus/);
    registry.registerShaper({ name: 'w', appliesTo: ['prose'], shape: () => undefined });
    expect(() => registry.registerShaper({ name: 'w', appliesTo: ['prose'], shape: () => undefined })).toThrow(/Duplicate/);
  });

  it('lists the built-ins in pipeline order', () => {
    expect(createBuiltinShaperRegistry().names()).toEqual(['dedupe-reads', 'strip-noise', 'fold-repeats', 'html-boilerplate', 'tabular', 'aliases']);
  });
});
