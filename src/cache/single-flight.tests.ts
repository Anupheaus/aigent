import { describe, expect, it } from 'vitest';
import { createSingleFlight } from './single-flight.js';

describe('createSingleFlight', () => {
  it('makes the first claimant the owner and later claimants wait for its outcome', async () => {
    const flights = createSingleFlight();
    const first = flights.claim('k');
    const second = flights.claim('k');
    expect(first.isOwner).toBe(true);
    expect(second.isOwner).toBe(false);
    if (!first.isOwner || second.isOwner) throw new Error('unreachable');
    first.settle('stored');
    await expect(second.outcome).resolves.toBe('stored');
  });

  it('frees the key once settled, so the next claimant owns a new flight', () => {
    const flights = createSingleFlight();
    const first = flights.claim('k');
    if (!first.isOwner) throw new Error('unreachable');
    first.settle('abandoned');
    expect(flights.claim('k').isOwner).toBe(true);
  });

  it('keeps keys independent and ignores a second settle', async () => {
    const flights = createSingleFlight();
    const one = flights.claim('a');
    const other = flights.claim('b');
    expect(one.isOwner && other.isOwner).toBe(true);
    const waiter = flights.claim('a');
    if (!one.isOwner || waiter.isOwner) throw new Error('unreachable');
    one.settle('abandoned');
    one.settle('stored');
    await expect(waiter.outcome).resolves.toBe('abandoned');
  });
});
