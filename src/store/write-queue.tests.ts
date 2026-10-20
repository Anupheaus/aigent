import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createWriteQueue } from './write-queue.js';

const sleep = (delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs));

describe('createWriteQueue', () => {
  it('runs writes for one key strictly in arrival order, never overlapping', async () => {
    const queue = createWriteQueue();
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;
    const write = (label: string, delayMs: number) => queue.enqueue('agent', async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      log.push(`start ${label}`);
      await sleep(delayMs);
      log.push(`end ${label}`);
      active -= 1;
    });
    await Promise.all([write('a', 15), write('b', 1), write('c', 5)]);
    expect(maxActive).toBe(1);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('does not serialise different keys against each other', async () => {
    const queue = createWriteQueue();
    let active = 0;
    let maxActive = 0;
    const write = (key: string) => queue.enqueue(key, async () => { active += 1; maxActive = Math.max(maxActive, active); await sleep(10); active -= 1; });
    await Promise.all([write('one'), write('two')]);
    expect(maxActive).toBe(2);
  });

  it('a failed write rejects its own promise but does not block later writes', async () => {
    const queue = createWriteQueue();
    const failing = queue.enqueue('k', async () => { throw new Error('bad'); });
    const next = queue.enqueue('k', async () => 'ok');
    await expect(failing).rejects.toThrow('bad');
    await expect(next).resolves.toBe('ok');
  });

  it('flush resolves only after every queued write finished', async () => {
    const queue = createWriteQueue();
    let finished = 0;
    for (const key of ['a', 'b', 'a']) void queue.enqueue(key, async () => { await sleep(5); finished += 1; });
    await queue.flush();
    expect(finished).toBe(3);
  });

  it('preserves per-key order under random interleavings', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: 0, max: 3 })), { minLength: 1, maxLength: 20 }), async plan => {
      const queue = createWriteQueue();
      const observed: Record<string, number[]> = { a: [], b: [], c: [] };
      const expected: Record<string, number[]> = { a: [], b: [], c: [] };
      plan.forEach(([key, delayMs], sequence) => {
        expected[key]!.push(sequence);
        void queue.enqueue(key, async () => { await sleep(delayMs); observed[key]!.push(sequence); });
      });
      await queue.flush();
      expect(observed).toEqual(expected);
    }), { numRuns: 25 });
  });
});
