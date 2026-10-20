import { describe, expect, it } from 'vitest';
import { bodyOptions, reservedOptionWarnings } from './provider-options.js';

const RESERVED = ['model', 'stream'];

describe('bodyOptions', () => {
  it('keeps every key except the reserved ones', () => {
    expect(bodyOptions({ providerOptions: { model: 'x', stream: false, top_k: 3, metadata: { a: 1 } }, reserved: RESERVED })).toEqual({ top_k: 3, metadata: { a: 1 } });
  });

  it('returns nothing without options', () => {
    expect(bodyOptions({ reserved: RESERVED })).toEqual({});
  });
});

describe('reservedOptionWarnings', () => {
  it('names each reserved key and the provider, in key order', () => {
    expect(reservedOptionWarnings({ providerId: 'p', providerOptions: { stream: false, top_k: 1, model: 'x' }, reserved: RESERVED })).toEqual([
      "Provider 'p' ignores providerOptions key 'stream': the adapter sets that field (use the matching model setting instead)",
      "Provider 'p' ignores providerOptions key 'model': the adapter sets that field (use the matching model setting instead)",
    ]);
  });

  it('warns about nothing when no reserved key is used', () => {
    expect(reservedOptionWarnings({ providerId: 'p', providerOptions: { top_k: 1 }, reserved: RESERVED })).toEqual([]);
    expect(reservedOptionWarnings({ providerId: 'p', reserved: RESERVED })).toEqual([]);
  });
});
