import type { PendingTurn } from './pending-turn.js';

export interface RequeueParams {
  /** Steering the ended turn never delivered. */
  leftovers: PendingTurn[];
  queue: PendingTurn[];
  /** With `onStop: 'discard'`: the messages that were waiting when the user stopped the turn. */
  discard?: ReadonlySet<string>;
  now: number;
}

export interface RequeueResult {
  queue: PendingTurn[];
  /** To be settled `cancelled`. */
  dropped: PendingTurn[];
}

/**
 * The queue after a turn ended: undelivered steering waits at its end, and a user stop with `onStop: 'discard'` drops
 * only what was waiting at stop time (a message sent after the stop is the user's next request, not part of it).
 */
export function requeue(params: RequeueParams): RequeueResult {
  const { leftovers, queue, discard = new Set<string>(), now } = params;
  const waiting = [...queue, ...leftovers.map(pending => ({ ...pending, queuedAt: pending.queuedAt ?? now }))];
  return {
    queue: waiting.filter(({ agentMessageId }) => !discard.has(agentMessageId)),
    dropped: waiting.filter(({ agentMessageId }) => discard.has(agentMessageId)),
  };
}
