import { describe, expect, it } from 'vitest';
import { parseRetention } from './retention.js';

describe('parseRetention', () => {
  it('accepts no retention and a positive integer expiresInMs', () => {
    expect(parseRetention(undefined)).toBeUndefined();
    expect(parseRetention({ expiresInMs: 60_000 })).toEqual({ expiresInMs: 60_000 });
    expect(parseRetention({})).toEqual({});
  });

  it.each([[{ expiresInMs: 0 }], [{ expiresInMs: 1.5 }], [{ expiresInMs: -1 }], [{ ttl: 5 }]])('rejects %j with invalid_definition', retention => {
    expect(() => parseRetention(retention)).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringContaining('retention') }));
  });
});
