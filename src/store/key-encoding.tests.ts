import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encodeName } from './key-encoding.js';

const MAX_LENGTH = 120;
const SAFE_NAME = /^[a-z0-9_%~-]+$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

describe('encodeName', () => {
  it('leaves plain lower-case names alone', () => {
    expect(encodeName('runs')).toBe('runs');
    expect(encodeName('tool-cache_1')).toBe('tool-cache_1');
  });

  it('escapes dots, separators, upper case and non-ASCII', () => {
    expect(encodeName('..')).toBe('%2e%2e');
    expect(encodeName('a/b')).toBe('a%2fb');
    expect(encodeName('A')).toBe('%41');
    expect(encodeName('é')).toBe('%c3%a9');
    expect(encodeName('')).toBe('%empty');
  });

  it('breaks up Windows device names', () => {
    for (const device of ['con', 'CON', 'nul', 'com1', 'LPT9', 'aux', 'prn']) {
      expect(encodeName(device)).not.toMatch(WINDOWS_DEVICE);
    }
  });

  it('keeps two names that differ only in case apart', () => {
    expect(encodeName('Key')).not.toBe(encodeName('key'));
    expect(encodeName('Key').toLowerCase()).not.toBe(encodeName('key').toLowerCase());
  });

  it('shortens long names but keeps different long names different', () => {
    const first = encodeName('a'.repeat(500));
    const second = encodeName('a'.repeat(499) + 'b');
    expect(first.length).toBeLessThanOrEqual(MAX_LENGTH);
    expect(second.length).toBeLessThanOrEqual(MAX_LENGTH);
    expect(first).not.toBe(second);
  });

  it('is injective (even ignoring case), safe and bounded for any string', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 200 }), fc.string({ unit: 'binary', maxLength: 200 }), (first, second) => {
      const encodedFirst = encodeName(first);
      expect(encodedFirst).toMatch(SAFE_NAME);
      expect(encodedFirst).not.toMatch(WINDOWS_DEVICE);
      expect(encodedFirst.length).toBeLessThanOrEqual(MAX_LENGTH);
      if (first !== second) expect(encodedFirst.toLowerCase()).not.toBe(encodeName(second).toLowerCase());
    }), { numRuns: 500 });
  });

  it('never yields a traversal name', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 50 }), name => {
      const encoded = encodeName(name);
      expect(encoded).not.toBe('.');
      expect(encoded).not.toBe('..');
      expect(encoded).not.toMatch(/[\\/:.]/);
    }));
  });
});
