import { describe, expect, it } from 'vitest';
import { buildRunnerEnv } from './env.js';
import type { BuildRunnerEnvParams, RunnerEnv } from './env.js';

interface EnvCase {
  label: string;
  params: BuildRunnerEnvParams;
  expected: RunnerEnv;
}

// Built at runtime so no credential-shaped literal sits in the source.
const fakeKey = ['sk', 'ant', 'test', 'value'].join('-');

describe('buildRunnerEnv', () => {
  it.each<EnvCase>([
    {
      label: 'keeps everything without subscription auth',
      params: { parent: { PATH: '/bin', ANTHROPIC_API_KEY: fakeKey }, useSubscriptionAuth: false },
      expected: { env: { PATH: '/bin', ANTHROPIC_API_KEY: fakeKey }, removed: [] },
    },
    {
      label: 'removes both API variables with subscription auth',
      params: { parent: { PATH: '/bin', ANTHROPIC_API_KEY: fakeKey, ANTHROPIC_AUTH_TOKEN: fakeKey, OTHER: 'x' }, useSubscriptionAuth: true },
      expected: { env: { PATH: '/bin', OTHER: 'x' }, removed: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] },
    },
    {
      label: 'compares names case-insensitively and also strips them from the given env',
      params: { parent: { anthropic_api_key: fakeKey }, env: { ANTHROPIC_AUTH_TOKEN: fakeKey, EXTRA: '1' }, useSubscriptionAuth: true },
      expected: { env: { EXTRA: '1' }, removed: ['anthropic_api_key', 'ANTHROPIC_AUTH_TOKEN'] },
    },
    {
      label: 'adds the given env over the parent and drops undefined values',
      params: { parent: { A: '1', B: undefined }, env: { A: '2' }, useSubscriptionAuth: false },
      expected: { env: { A: '2' }, removed: [] },
    },
    {
      label: 'reports nothing removed when there was nothing to remove',
      params: { parent: { PATH: '/bin' }, useSubscriptionAuth: true },
      expected: { env: { PATH: '/bin' }, removed: [] },
    },
  ])('$label', ({ params, expected }) => {
    expect(buildRunnerEnv(params)).toEqual(expected);
  });

  it('never changes the parent environment', () => {
    const parent = { ANTHROPIC_API_KEY: fakeKey };
    buildRunnerEnv({ parent, useSubscriptionAuth: true });
    expect(parent).toEqual({ ANTHROPIC_API_KEY: fakeKey });
  });
});
