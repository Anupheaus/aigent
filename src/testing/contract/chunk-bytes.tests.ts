import { describe, expect, it } from 'vitest';
import { chunkBytes } from './chunk-bytes.js';

describe('chunkBytes', () => {
  it('splits the UTF-8 bytes into chunks of the given size, cutting multi-byte characters', () => {
    const chunks = chunkBytes('aé😀', 2);
    expect(chunks.map(chunk => chunk.length)).toEqual([2, 2, 2, 1]);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe('aé😀');
  });

  it('returns no chunks for empty text', () => {
    expect(chunkBytes('', 3)).toEqual([]);
  });

  it.each([0, -1, 1.5])('rejects size %s', size => {
    expect(() => chunkBytes('x', size)).toThrow(/positive integer; got/);
  });
});
