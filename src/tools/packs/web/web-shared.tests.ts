import { describe, expect, it } from 'vitest';
import { createFetchHttpAccess } from '../../../security/http-access-fetch.js';
import { createHttpPolicy } from '../../../security/http-policy.js';
import { resolveWebDeps } from './web-shared.js';

describe('resolveWebDeps', () => {
  const policy = createHttpPolicy({ allowDomains: ['**'], allowAnyPublic: true });

  it('defaults to an access that connects to the address the policy checked, so DNS rebinding cannot redirect it (review I1)', () => {
    expect(resolveWebDeps({ policy }).access.pinsAddress).toBe(true);
  });

  it('keeps an access the consumer chose, even one that cannot pin', () => {
    expect(resolveWebDeps({ policy, access: createFetchHttpAccess() }).access.pinsAddress).toBe(false);
  });
});
