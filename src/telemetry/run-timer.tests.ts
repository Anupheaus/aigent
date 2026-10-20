import { describe, expect, it } from 'vitest';
import { createRunTimer } from './run-timer.js';

function fakeClock(start: number) {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

describe('createRunTimer', () => {
  it('records the first token once, relative to the start', () => {
    const clock = fakeClock(1_000);
    const timer = createRunTimer({ now: clock.now });
    clock.advance(25);
    timer.markFirstToken();
    clock.advance(10);
    timer.markFirstToken();
    expect(timer.snapshot()).toEqual({ startedAt: 1_000, firstTokenMs: 25, modelMs: 0, queuedMs: 0 });
  });

  it('counts model time per turn without the time it spent queued', () => {
    const clock = fakeClock(0);
    const timer = createRunTimer({ now: clock.now });
    const endFirst = timer.startTurn();
    clock.advance(40);
    timer.addQueuedMs(15);
    endFirst();
    const endSecond = timer.startTurn();
    clock.advance(10);
    endSecond();
    expect(timer.snapshot()).toEqual({ startedAt: 0, modelMs: 35, queuedMs: 15 });
  });

  it('never reports negative model time', () => {
    const clock = fakeClock(0);
    const timer = createRunTimer({ now: clock.now });
    const end = timer.startTurn();
    timer.addQueuedMs(50);
    end();
    expect(timer.snapshot().modelMs).toBe(0);
  });
});
