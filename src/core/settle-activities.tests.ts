import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleActivities } from './settle-activities.js';

const GRACE_MS = 500;
const NEVER = (): Promise<void> => new Promise(() => undefined);

describe('settleActivities', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves true once every activity settled, leaving no timer behind', async () => {
    const isSettled = await settleActivities({ activities: [Promise.resolve(), Promise.resolve()], signal: new AbortController().signal, graceMs: GRACE_MS });
    expect(isSettled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves false when an activity is still pending after the grace period', async () => {
    const pending = settleActivities({ activities: [Promise.resolve(), NEVER()], signal: new AbortController().signal, graceMs: GRACE_MS });
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(await pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves false as soon as the run signal aborts, without waiting for the grace period', async () => {
    const controller = new AbortController();
    const pending = settleActivities({ activities: [NEVER()], signal: controller.signal, graceMs: GRACE_MS });
    controller.abort();
    expect(await pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves true immediately when there are no activities', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await settleActivities({ activities: [], signal: controller.signal, graceMs: GRACE_MS })).toBe(true);
  });
});
