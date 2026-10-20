import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createTokenBucket } from './token-bucket.js';

const WINDOW_MS = 60_000;

describe('createTokenBucket', () => {
  it('admits spending up to its capacity within one window', () => {
    const bucket = createTokenBucket({ capacity: 100, windowMs: WINDOW_MS });
    expect(bucket.canSpend({ amount: 60, now: 0 })).toBe(true);
    bucket.spend({ amount: 60, now: 0 });
    expect(bucket.canSpend({ amount: 40, now: 1 })).toBe(true);
    expect(bucket.canSpend({ amount: 41, now: 1 })).toBe(false);
  });

  it('returns spent tokens exactly one window after they were spent', () => {
    const bucket = createTokenBucket({ capacity: 100, windowMs: WINDOW_MS });
    bucket.spend({ amount: 100, now: 1_000 });
    expect(bucket.canSpend({ amount: 1, now: 60_999 })).toBe(false);
    expect(bucket.canSpend({ amount: 100, now: 61_000 })).toBe(true);
  });

  it('says how long until an amount fits', () => {
    const bucket = createTokenBucket({ capacity: 100, windowMs: WINDOW_MS });
    bucket.spend({ amount: 30, now: 0 });
    bucket.spend({ amount: 50, now: 10_000 });
    expect(bucket.waitMs({ amount: 20, now: 20_000 })).toBe(0);
    expect(bucket.waitMs({ amount: 40, now: 20_000 })).toBe(40_000);
    expect(bucket.waitMs({ amount: 80, now: 20_000 })).toBe(50_000);
  });

  it('lets an amount larger than the capacity through only when nothing else is in the window', () => {
    const bucket = createTokenBucket({ capacity: 100, windowMs: WINDOW_MS });
    expect(bucket.canSpend({ amount: 500, now: 0 })).toBe(true);
    bucket.spend({ amount: 10, now: 0 });
    expect(bucket.canSpend({ amount: 500, now: 1 })).toBe(false);
    expect(bucket.waitMs({ amount: 500, now: 1 })).toBe(59_999);
  });

  it('reconciles an estimate with the actual amount', () => {
    const bucket = createTokenBucket({ capacity: 100, windowMs: WINDOW_MS });
    const spent = bucket.spend({ amount: 90, now: 0 });
    expect(bucket.canSpend({ amount: 50, now: 1 })).toBe(false);
    spent.reconcile(40);
    expect(bucket.canSpend({ amount: 60, now: 1 })).toBe(true);
    expect(bucket.used(1)).toBe(40);
  });

  it('property: admitting only what canSpend allows never exceeds capacity in any window', () => {
    fc.assert(fc.property(fc.array(fc.record({ gap: fc.nat({ max: 20_000 }), amount: fc.integer({ min: 1, max: 40 }) }), { maxLength: 200 }), requests => {
      const bucket = createTokenBucket({ capacity: 100, windowMs: WINDOW_MS });
      const admitted: { at: number; amount: number }[] = [];
      let now = 0;
      for (const { gap, amount } of requests) {
        now += gap;
        if (!bucket.canSpend({ amount, now })) continue;
        bucket.spend({ amount, now });
        admitted.push({ at: now, amount });
      }
      for (const { at } of admitted) {
        const inWindow = admitted.filter(entry => entry.at >= at && entry.at < at + WINDOW_MS).reduce((sum, entry) => sum + entry.amount, 0);
        expect(inWindow).toBeLessThanOrEqual(100);
      }
    }));
  });
});
