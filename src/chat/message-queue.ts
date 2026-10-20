import { createAigentError } from '../core/aigent-error.js';
import type { QueuedMessage } from './conversation.js';

/** What the queue needs to know about an entry; the engine's pending turns carry more. */
export interface QueueEntry {
  user?: { id: string; text: string };
  queuedAt?: number;
  coalesce?: boolean;
}

function missing(params: { id: string; startedIds: ReadonlySet<string> }): Error {
  const { id, startedIds } = params;
  const reason = startedIds.has(id) ? 'it has already started, so it can no longer be changed' : 'no queued message has that id';
  return createAigentError({ code: 'invalid_input', message: `Queued message '${id}' cannot be changed: ${reason}`, details: { messageId: id } });
}

function indexOf(params: { queue: readonly QueueEntry[]; id: string; startedIds: ReadonlySet<string> }): number {
  const { queue, id, startedIds } = params;
  const index = queue.findIndex(({ user }) => user?.id === id);
  if (index === -1) throw missing({ id, startedIds });
  return index;
}

/** The queue as the conversation shows it. */
export function queuedMessages(queue: readonly QueueEntry[]): QueuedMessage[] {
  return queue.flatMap(({ user, queuedAt = 0, coalesce }) => (user == null ? [] : [{ id: user.id, text: user.text, queuedAt, ...(coalesce === true ? { coalesce } : {}) }]));
}

/** Replaces a queued message's text (it has not started). */
export function editQueued<T extends QueueEntry>(params: { queue: T[]; id: string; text: string; startedIds: ReadonlySet<string> }): T[] {
  const { queue, id, text, startedIds } = params;
  const index = indexOf({ queue, id, startedIds });
  return queue.map((entry, position) => (position === index && entry.user != null ? { ...entry, user: { ...entry.user, text } } : entry));
}

/** Moves a queued message to `toIndex` (clamped to the queue). */
export function moveQueued<T extends QueueEntry>(params: { queue: T[]; id: string; toIndex: number; startedIds: ReadonlySet<string> }): T[] {
  const { queue, id, toIndex, startedIds } = params;
  const index = indexOf({ queue, id, startedIds });
  if (!Number.isInteger(toIndex)) throw createAigentError({ code: 'invalid_input', message: `Queue position must be an integer, got ${toIndex}`, details: { messageId: id } });
  const target = Math.min(Math.max(toIndex, 0), queue.length - 1);
  const moved = queue.filter((_entry, position) => position !== index);
  moved.splice(target, 0, queue[index] as T);
  return moved;
}

/** Takes a queued message out; returns the queue without it and the entry. */
export function removeQueued<T extends QueueEntry>(params: { queue: T[]; id: string; startedIds: ReadonlySet<string> }): { queue: T[]; removed: T } {
  const { queue, id, startedIds } = params;
  const index = indexOf({ queue, id, startedIds });
  return { queue: queue.filter((_entry, position) => position !== index), removed: queue[index] as T };
}

/**
 * The entries the next turn answers: the head, plus the entries right behind it while the head and each of them ask
 * to coalesce. Only adjacent entries merge, so a message that did not ask to is never folded into another turn.
 */
export function takeNext<T extends QueueEntry>(queue: T[]): { taken: T[]; rest: T[] } {
  const [head, ...others] = queue;
  if (head == null) return { taken: [], rest: [] };
  if (head.coalesce !== true || head.user == null) return { taken: [head], rest: others };
  const followers: T[] = [];
  for (const entry of others) {
    if (entry.coalesce !== true || entry.user == null) break;
    followers.push(entry);
  }
  return { taken: [head, ...followers], rest: others.slice(followers.length) };
}
