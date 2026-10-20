import { describe, expect, it } from 'vitest';
import { splitPrevious } from './previous-outcome.js';

describe('splitPrevious', () => {
  it('takes a valid previous out of the arguments', () => {
    expect(splitPrevious({ path: 'a', previous: { success: true, answer: 'found it' } })).toEqual({ args: { path: 'a' }, previous: { kind: 'reported', outcome: { success: true, answer: 'found it' } } });
  });

  it('treats null and an absent previous as not reported', () => {
    expect(splitPrevious({ path: 'a', previous: null })).toEqual({ args: { path: 'a' }, previous: { kind: 'missing' } });
    expect(splitPrevious({ path: 'a' })).toEqual({ args: { path: 'a' }, previous: { kind: 'missing' } });
  });

  it('strips an invalid previous and says precisely why', () => {
    expect(splitPrevious({ path: 'a', previous: { success: 'yes', answer: 'x'.repeat(301) } })).toEqual({
      args: { path: 'a' },
      previous: { kind: 'invalid', reason: expect.stringMatching(/success: .*boolean.*; answer: .*300/) },
    });
  });

  it('leaves arguments that are not an object alone', () => {
    expect(splitPrevious('raw')).toEqual({ args: 'raw', previous: { kind: 'missing' } });
    expect(splitPrevious(null)).toEqual({ args: null, previous: { kind: 'missing' } });
  });

  it('does not mutate the arguments it was given', () => {
    const args = { path: 'a', previous: null };
    splitPrevious(args);
    expect(args).toEqual({ path: 'a', previous: null });
  });
});
