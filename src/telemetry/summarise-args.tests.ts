import { describe, expect, it } from 'vitest';
import { summariseArgs } from './summarise-args.js';

describe('summariseArgs', () => {
  it('keeps canonical JSON (sorted keys) with content capture', () => {
    expect(summariseArgs({ args: { b: 1, a: 'x' }, captureContent: true })).toBe('{"a":"x","b":1}');
  });

  it('keeps only the shape without content capture', () => {
    expect(summariseArgs({ args: { query: 'secret', limit: 5, tags: ['a', 'b'], filter: null }, captureContent: false })).toBe('{"filter":null,"limit":"<number>","query":"<string>","tags":["<string>","<string>"]}');
  });

  it('summarises missing arguments as an empty string and cuts long ones at 120 characters', () => {
    expect(summariseArgs({ args: undefined, captureContent: true })).toBe('');
    expect(summariseArgs({ args: 'y'.repeat(300), captureContent: true })).toHaveLength(120);
  });
});
