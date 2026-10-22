import { describe, expect, it } from 'vitest';
import { numstatPaths, parseNumstat } from './git-parse.js';

describe('numstatPaths', () => {
  it('lists every path once, a rename by its source and destination, binary files included', () => {
    const output = ['1\t2\ta.txt', '-\t-\timage.png', '3\t0\t', 'old name.txt', 'new\tname.txt', '1\t1\ta.txt', ''].join('\0');
    expect(numstatPaths(output)).toEqual(['a.txt', 'image.png', 'old name.txt', 'new\tname.txt']);
    expect(parseNumstat(output)).toEqual({ files: 4, insertions: 5, deletions: 3 });
  });

  it('keeps a path holding a line break', () => {
    expect(numstatPaths('1\t0\tline\nbreak.txt\0')).toEqual(['line\nbreak.txt']);
  });

  it('is empty for no changes', () => {
    expect(numstatPaths('')).toEqual([]);
  });
});
