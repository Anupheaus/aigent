import { describe, expect, it } from 'vitest';
import type { ProviderEvent } from '../providers/provider-types.js';
import { createResponseCache, isReproducible } from './response-cache.js';
import type { ResponseCacheKeyParts } from './response-cache.js';

const PARTS: ResponseCacheKeyParts = { providerId: 'p', model: 'm', settings: { temperature: 0 }, messages: [{ role: 'user', text: 'q' }], tools: [], agentVersion: 'v', scope: 'i' };
const EVENTS: ProviderEvent[] = [{ type: 'text-delta', text: 'a' }, { type: 'done', finishReason: 'stop' }];

describe('createResponseCache', () => {
  it('keys on every part', () => {
    const cache = createResponseCache({ options: { ttlMs: 10 }, now: () => 0 });
    const base = cache.key(PARTS);
    expect(cache.key({ ...PARTS })).toBe(base);
    for (const changed of [{ providerId: 'q' }, { model: 'n' }, { settings: { temperature: 0, seed: 1 } }, { messages: [] }, { tools: [{ name: 't', description: 'd', parameters: {}, strict: true }] }, { agentVersion: 'w' }, { scope: 'j' }]) {
      expect(cache.key({ ...PARTS, ...changed })).not.toBe(base);
    }
  });

  it('serves copies while fresh and drops the least recently used past maxEntries', () => {
    let now = 0;
    const cache = createResponseCache({ options: { ttlMs: 10, maxEntries: 2 }, now: () => now });
    cache.set('a', EVENTS);
    cache.set('b', EVENTS);
    const served = cache.get('a');
    served?.push({ type: 'text-delta', text: 'tampered' });
    expect(cache.get('a')).toEqual(EVENTS);
    cache.set('c', EVENTS);
    // 'a' was used after 'b', so 'b' went.
    expect(cache.get('b')).toBeUndefined();
    now = 10;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size()).toBe(1);
  });

  it('treats only temperature 0 or a seed as reproducible', () => {
    expect(isReproducible({ temperature: 0 })).toBe(true);
    expect(isReproducible({ temperature: 1, seed: 0 })).toBe(true);
    expect(isReproducible({ temperature: 0.1 })).toBe(false);
    expect(isReproducible(undefined)).toBe(false);
  });
});
