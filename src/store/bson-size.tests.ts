import { describe, expect, it } from 'vitest';
import { bsonSize } from './bson-size.js';

describe('bsonSize', () => {
  it('matches the byte counts of the BSON specification examples', () => {
    expect(bsonSize({})).toBe(5);
    // bsonspec.org: {"hello": "world"} is 22 bytes and {"BSON": ["awesome", 5.05, 1986]} is 49.
    expect(bsonSize({ hello: 'world' })).toBe(22);
    expect(bsonSize({ BSON: ['awesome', 5.05, 1986] })).toBe(49);
  });

  it('counts integers outside int32 as doubles, booleans as one byte, null and undefined as none', () => {
    expect(bsonSize({ a: 1 })).toBe(12);
    expect(bsonSize({ a: 2 ** 40 })).toBe(16);
    expect(bsonSize({ a: true })).toBe(9);
    expect(bsonSize({ a: null })).toBe(8);
    expect(bsonSize({ a: undefined })).toBe(8);
  });

  it('counts strings and field names in UTF-8 bytes', () => {
    expect(bsonSize({ é: 'é' })).toBe(bsonSize({ ab: 'ab' }));
  });
});
