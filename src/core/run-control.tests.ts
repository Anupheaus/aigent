import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunControl } from './run-control.js';

const TIMEOUT_MS = 1_000;

describe('createRunControl', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('aborts once with reason user; repeated stops are no-ops', () => {
    const { control, stop } = createRunControl({});
    const onAbort = vi.fn();
    control.abortController.signal.addEventListener('abort', onAbort);
    stop();
    stop({ mode: 'immediate' });
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(control.abortReason()).toBe('user');
  });

  it('graceful stop only sets the flag', () => {
    const { control, stop } = createRunControl({});
    stop({ mode: 'graceful' });
    expect(control.isGracefulStopRequested()).toBe(true);
    expect(control.abortController.signal.aborted).toBe(false);
  });

  it('aborts with reason timeout when the timer fires', () => {
    vi.useFakeTimers();
    const { control } = createRunControl({ timeoutMs: TIMEOUT_MS });
    vi.advanceTimersByTime(TIMEOUT_MS);
    expect(control.abortReason()).toBe('timeout');
    expect(control.abortController.signal.aborted).toBe(true);
  });

  it('follows an already-aborted or later-aborted external signal', () => {
    const preAborted = new AbortController();
    preAborted.abort();
    expect(createRunControl({ signal: preAborted.signal }).control.abortController.signal.aborted).toBe(true);
    const external = new AbortController();
    const { control } = createRunControl({ signal: external.signal });
    external.abort();
    expect(control.abortReason()).toBe('user');
  });

  it('dispose clears the timer, detaches from the external signal and disables stop', () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const removeListener = vi.spyOn(external.signal, 'removeEventListener');
    const { control, stop, dispose } = createRunControl({ signal: external.signal, timeoutMs: TIMEOUT_MS });
    dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    external.abort();
    stop();
    expect(control.abortController.signal.aborted).toBe(false);
  });
});
