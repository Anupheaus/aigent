import { describe, expect, it } from 'vitest';
import { editQueued, moveQueued, queuedMessages, removeQueued, takeNext } from './message-queue.js';
import type { QueueEntry } from './message-queue.js';

function entry(id: string, coalesce?: boolean): QueueEntry {
  return { user: { id, text: id.toUpperCase() }, queuedAt: 1, ...(coalesce == null ? {} : { coalesce }) };
}

const NONE: ReadonlySet<string> = new Set();
const ids = (queue: QueueEntry[]): (string | undefined)[] => queue.map(({ user }) => user?.id);

describe('message queue', () => {
  it('edits, moves and removes before start, keeping every other entry in order', () => {
    const queue = [entry('a'), entry('b'), entry('c'), entry('d')];
    expect(editQueued({ queue, id: 'b', text: 'new', startedIds: NONE })[1]?.user?.text).toBe('new');
    expect(ids(moveQueued({ queue, id: 'd', toIndex: 0, startedIds: NONE }))).toEqual(['d', 'a', 'b', 'c']);
    expect(ids(moveQueued({ queue, id: 'a', toIndex: 99, startedIds: NONE }))).toEqual(['b', 'c', 'd', 'a']);
    const { queue: rest, removed } = removeQueued({ queue, id: 'c', startedIds: NONE });
    expect([ids(rest), removed.user?.id]).toEqual([['a', 'b', 'd'], 'c']);
    expect(queuedMessages(queue).map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('says precisely why a message cannot be changed', () => {
    const queue = [entry('a')];
    expect(() => editQueued({ queue, id: 'x', text: 't', startedIds: new Set(['x']) })).toThrow("Queued message 'x' cannot be changed: it has already started");
    expect(() => removeQueued({ queue, id: 'y', startedIds: NONE })).toThrow('no queued message has that id');
    expect(() => moveQueued({ queue, id: 'a', toIndex: 1.5, startedIds: NONE })).toThrow(/must be an integer/);
  });

  it('coalesces only the adjacent entries that ask to', () => {
    const queue = [entry('a', true), entry('b', true), entry('c'), entry('d', true)];
    const first = takeNext(queue);
    expect([ids(first.taken), ids(first.rest)]).toEqual([['a', 'b'], ['c', 'd']]);
    const second = takeNext(first.rest);
    expect([ids(second.taken), ids(second.rest)]).toEqual([['c'], ['d']]);
    expect(takeNext([])).toEqual({ taken: [], rest: [] });
  });
});
