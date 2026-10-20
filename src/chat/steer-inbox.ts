import type { SteerSource } from '../core/run-agent-turns.js';
import type { ProviderMessage } from '../providers/provider-types.js';

export interface SteerInbox<T> extends SteerSource {
  push(entry: T): void;
  /** Whatever was never delivered (the turn ended first); empties the inbox. */
  drain(): T[];
}

export interface CreateSteerInboxParams<T> {
  /** What the model is sent for an entry. */
  toMessage(entry: T): ProviderMessage;
  /** Called at the safe boundary with the entries being delivered, before the model sees them. */
  onDeliver?(entries: T[]): void;
}

/** Messages for a running turn, delivered at its next safe boundary (after tool results, before the next request). */
export function createSteerInbox<T>(params: CreateSteerInboxParams<T>): SteerInbox<T> {
  const { toMessage, onDeliver } = params;
  let entries: T[] = [];
  return {
    push: entry => { entries.push(entry); },
    take: () => {
      const delivered = entries;
      entries = [];
      if (delivered.length > 0) onDeliver?.(delivered);
      return delivered.map(toMessage);
    },
    drain: () => {
      const left = entries;
      entries = [];
      return left;
    },
  };
}
