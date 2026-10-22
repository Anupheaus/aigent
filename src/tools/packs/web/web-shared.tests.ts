import { describe, expect, it } from 'vitest';
import { createFetchHttpAccess } from '../../../security/http-access-fetch.js';
import { createHttpPolicy } from '../../../security/http-policy.js';
import { resolveWebDeps } from './web-shared.js';
import { webTools } from './web-tools.js';

describe('resolveWebDeps', () => {
  const policy = createHttpPolicy({ allowDomains: ['**'], allowAnyPublic: true });

  it('defaults to an access that connects to the address the policy checked, so DNS rebinding cannot redirect it (review I1)', () => {
    expect(resolveWebDeps({ policy }).access.pinsAddress).toBe(true);
  });

  it('gives the fetch tools time for every redirect hop at the policy\'s timeout, not the 30-second default (review M8)', () => {
    const slow = createHttpPolicy({ allowDomains: ['example.com'], timeoutMs: 60_000, maxRedirects: 2 });
    const tools = webTools({ policy: slow });
    const expected = 60_000 * 3 + 5_000;
    expect(tools.map(({ name, timeoutMs }) => [name, timeoutMs])).toEqual([['http_fetch', expected], ['page_extract', expected]]);
  });

  it('keeps an access the consumer chose, even one that cannot pin', () => {
    expect(resolveWebDeps({ policy, access: createFetchHttpAccess() }).access.pinsAddress).toBe(false);
  });
});
