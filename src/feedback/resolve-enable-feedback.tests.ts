import { describe, expect, it } from 'vitest';
import { resolveEnableFeedback } from './resolve-enable-feedback.js';

describe('resolveEnableFeedback', () => {
  it.each([
    [undefined, {}, true],
    [undefined, { NODE_ENV: 'development' }, true],
    [undefined, { NODE_ENV: 'test' }, true],
    [undefined, { NODE_ENV: 'production' }, false],
    [true, { NODE_ENV: 'production' }, true],
    [false, { NODE_ENV: 'development' }, false],
    [false, {}, false],
  ])('explicit %s with env %j resolves to %s', (explicit, env, expected) => {
    expect(resolveEnableFeedback({ explicit, env })).toBe(expected);
  });
});
