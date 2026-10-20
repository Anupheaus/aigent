import { describe, expect, it } from 'vitest';
import { resolveCacheOptions } from './cache-options.js';

describe('resolveCacheOptions', () => {
  it('fills in the defaults', () => {
    expect(resolveCacheOptions(undefined)).toEqual({ maxEntries: 1_000, maxBytes: 64 * 1_024 * 1_024, maxEntryBytes: 256 * 1_024 });
    expect(resolveCacheOptions({ maxEntries: 5 })).toMatchObject({ maxEntries: 5 });
  });

  it('rejects non-positive and non-integer limits and unknown keys, naming each', () => {
    const bad = { maxEntries: 0, maxBytes: 1.5, ttl: 3 } as unknown as Parameters<typeof resolveCacheOptions>[0];
    expect(() => resolveCacheOptions(bad)).toThrow(expect.objectContaining({
      code: 'invalid_definition',
      message: expect.stringMatching(/unknown option 'ttl'.*maxEntries must be a positive integer, got 0.*maxBytes must be a positive integer, got 1\.5/),
    }));
  });
});
